import { afterEach, describe, expect, it } from "vitest";
import { GET as v1Impact } from "@/app/api/v1/services/impact/route";
import { GET as impactGet } from "@/app/api/services/impact/route";
import { createApiToken } from "@/lib/api/tokens";
import { updateChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { saveRun } from "@/lib/diagnostics/store";
import type { Finding, RunSummary } from "@/lib/diagnostics/types";
import { computeImpact, matchOf } from "@/lib/provisioning/impact";
import type { ServiceInstance } from "@/lib/provisioning/instances";
import { createService } from "@/lib/provisioning/instances";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const svc = (name: string, touches: ServiceInstance["touches"], status: ServiceInstance["status"] = "active"): ServiceInstance =>
  ({ id: name, scopeId: "s", serviceId: "x", title: "Thing", name, status, values: {}, devices: [...new Set(touches.map((t) => t.device))], applied: null, pending: null, touches, removable: true, notRemovable: null, createdBy: null, createdAt: "", updatedAt: "", retiredAt: null });
const finding = (over: Partial<Finding> = {}): Finding => ({ id: "f1", kind: "interface-down", severity: "critical", status: "confirmed", device: "R1", deviceId: "r1", interface: "GigabitEthernet0/1", peer: { device: "R2", deviceId: "r2", interface: "GigabitEthernet0/1" }, linkId: "l1", title: "Link down", description: "", evidence: [], probableCause: "", recommendedAction: "", verification: "", ...over });

describe("which services a finding reaches", () => {
  it("matches the interface a service is bound to, whatever way the name is written", () => {
    expect(matchOf(svc("a", [{ device: "R1", interface: "Gi0/1" }]), finding())).toBe("interface");
    expect(matchOf(svc("a", [{ device: "R1", interface: "gigabitethernet0/1" }]), finding())).toBe("interface");
    expect(matchOf(svc("a", [{ device: "R1", interface: "Ethernet0/2" }]), finding({ interface: "Eth0/2", peer: null }))).toBe("interface");
  });

  it("follows a link to the device at its other end", () => {
    expect(matchOf(svc("far end", [{ device: "R2", interface: "Gi0/1" }]), finding())).toBe("interface");
  });

  it("does not blame a service on one interface for a problem on another interface of the same device", () => {
    expect(matchOf(svc("elsewhere", [{ device: "R1", interface: "Gi0/2" }]), finding())).toBeNull();
    expect(matchOf(svc("other link", [{ device: "R2", interface: "Gi0/5" }]), finding())).toBeNull();
  });

  it("marks a service that is on the device but not tied to an interface as possibly affected, at the lower level", () => {
    expect(matchOf(svc("vlan", [{ device: "R1", interface: null }]), finding())).toBe("device");
    expect(matchOf(svc("ntp", [{ device: "R2", interface: null }]), finding())).toBe("device");
    expect(matchOf(svc("elsewhere", [{ device: "R9", interface: null }]), finding())).toBeNull();
  });

  it("reaches every service on a device for a problem with the whole device", () => {
    const whole = finding({ interface: null, peer: null, linkId: null, kind: "bgp-peer-down" });
    expect(matchOf(svc("on gi0/3", [{ device: "R1", interface: "Gi0/3" }]), whole)).toBe("device");
    expect(matchOf(svc("on r2", [{ device: "R2", interface: "Gi0/3" }]), whole)).toBeNull();
  });

  it("prefers the stronger match when a service touches several things", () => {
    expect(matchOf(svc("both", [{ device: "R1", interface: null }, { device: "R1", interface: "Gi0/1" }]), finding())).toBe("interface");
  });
});

describe("the impact view", () => {
  it("lists affected services per finding and the findings per service, worst first, and leaves out what nothing touches", () => {
    const services = [svc("uplink", [{ device: "R1", interface: "Gi0/1" }]), svc("vlan 10", [{ device: "R1", interface: null }]), svc("remote", [{ device: "R7", interface: "Gi0/1" }])];
    const findings = [finding({ id: "info", severity: "info", title: "Ping unread", interface: null, peer: null }), finding({ id: "down" })];
    const r = computeImpact(services, findings);
    expect(r.findings.map((f) => [f.findingId, f.affected.map((a) => `${a.name}:${a.match}`)])).toEqual([["down", ["uplink:interface", "vlan 10:device"]], ["info", ["uplink:device", "vlan 10:device"]]]);
    expect(r.services.map((s) => s.name).sort()).toEqual(["uplink", "vlan 10"]);
    expect(r.services.find((s) => s.name === "uplink")!.risks.map((x) => [x.findingId, x.severity])).toEqual([["down", "critical"], ["info", "info"]]);
    expect(r.services.find((s) => s.name === "remote")).toBeUndefined();
  });

  it("ignores services that are not on any device: retired, and ones that were never applied", () => {
    const f = [finding()];
    expect(computeImpact([svc("gone", [{ device: "R1", interface: "Gi0/1" }], "retired"), svc("never", [{ device: "R1", interface: "Gi0/1" }], "inactive")], f)).toEqual({ findings: [], services: [] });
    expect(computeImpact([svc("failed", [{ device: "R1", interface: "Gi0/1" }], "failed"), svc("pending", [{ device: "R1", interface: "Gi0/1" }], "pending")], f).findings[0].affected).toHaveLength(2);
  });

  it("is empty when there are no findings, so a healthy network shows nothing at risk", () => {
    expect(computeImpact([svc("a", [{ device: "R1", interface: "Gi0/1" }])], [])).toEqual({ findings: [], services: [] });
  });
});

describe("the impact API", () => {
  const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
  afterEach(() => { setContext(undefined); setProviders(null); });

  it("joins a real diagnostics run with a real service, over the API", async () => {
    process.env.TS_IMP_PW = "x";
    const file = join(mkdtempSync(join(tmpdir(), "ts-imp-")), "inv.yaml");
    writeFileSync(file, "credentials:\n  c: { username: admin, password: env:TS_IMP_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: 1, platform: ios }\n      - { name: R2, address: 127.0.0.2, port: 1, platform: ios }\n");
    const db = openDatabase(":memory:");
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "x", lastConnectAttempt: 0, anthropic: null, claude });
    setProviders([new StaticProvider(file)]);
    const { service, change } = await createService({ scopeId: "static:s", serviceId: "routed-interface", name: "Uplink to R2", values: { interface: "GigabitEthernet0/1", address: "10.0.0.1/30" }, devices: ["R1"] });
    updateChange(db, change.id, { status: "verified" });
    const run: RunSummary = { id: "r1", labId: "static:s", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", devices: [{ nodeId: "r1", label: "R1", kind: "router", inspected: true, reason: null, commandsRun: 4, commandsFailed: 0 }], interfaces: {}, pings: [], notRun: [] };
    saveRun(db, run, [finding()]);

    const token = createApiToken(db, { name: "ro", role: "viewer" }).token;
    const call = (h: unknown, url: string) => (h as (r: Request, c: unknown) => Promise<Response>)(new Request(`http://tinysnitch.corp.example:3000${url}`, { headers: { host: "tinysnitch.corp.example:3000", authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
    const r = await (await call(v1Impact, "/api/v1/services/impact?scope=static:s")).json();
    expect(r.findings[0]).toMatchObject({ findingId: "f1", severity: "critical", affected: [{ serviceId: service.id, name: "Uplink to R2", match: "interface" }] });
    expect(r.services[0]).toMatchObject({ name: "Uplink to R2", risks: [{ findingId: "f1", match: "interface" }] });
    // another network has nothing
    expect(await (await call(impactGet, "/api/services/impact?scope=static:other")).json()).toMatchObject({ findings: [], services: [] });
  });
});
