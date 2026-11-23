import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as v1Get, POST as v1Post } from "@/app/api/v1/services/route";
import { DELETE as v1Delete, GET as v1One, PUT as v1Put } from "@/app/api/v1/services/[id]/route";
import { createApiToken } from "@/lib/api/tokens";
import { createWebhook, listDeliveries, setAutoDeliver } from "@/lib/api/webhooks";
import { createChange, deleteChange, getChange, updateChange } from "@/lib/changes/store";
import { blockedLines } from "@/lib/core/safety";
import type { Platform } from "@/lib/core/types";
import { openDatabase } from "@/lib/database/db";
import { listAudit } from "@/lib/database/repo";
import { CATALOG, serviceById, validate } from "@/lib/provisioning/catalog";
import { ServiceError, createService, decommissionService, forgetService, getService, listServices, modifyService, reconcileAll, retryService } from "@/lib/provisioning/instances";
import { IDENTITY, identityChanged, isRemovable, notRemovableReason, planDecommission, planModify, removeLines, touches } from "@/lib/provisioning/lifecycle";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { resetRateLimits } from "@/lib/api/tokens";

const def = (id: string) => serviceById(id)!;
const ok = (id: string, v: Record<string, string | number | boolean>) => validate(def(id), v);
const SCOPE = "static:s";
const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };

function boot() {
  process.env.TS_SVC_PW = "x";
  const file = join(mkdtempSync(join(tmpdir(), "ts-svc-")), "inv.yaml");
  writeFileSync(file, "credentials:\n  c: { username: admin, password: env:TS_SVC_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: 1, platform: ios }\n      - { name: R2, address: 127.0.0.2, port: 1, platform: ios }\n      - { name: J1, address: 127.0.0.3, port: 1, platform: junos }\n");
  const db = openDatabase(":memory:");
  setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", lastConnectAttempt: 0, anthropic: null, claude });
  setProviders([new StaticProvider(file)]);
  return db;
}
beforeEach(() => setAutoDeliver(false));
afterEach(() => { setContext(undefined); setProviders(null); resetRateLimits(); setAutoDeliver(true); });

const SAMPLE: Record<string, Record<string, string | number | boolean>> = {
  vlan: { id: 10, name: "USERS" }, "access-port": { interface: "Gi0/1", vlan: 10, description: "pc" }, "trunk-port": { interface: "Gi0/2", vlans: "10,20", description: "uplink" },
  "routed-interface": { interface: "Gi0/3", address: "10.0.0.1/30", description: "to R2" }, svi: { vlan: 10, address: "10.10.10.1/24" }, "static-route": { prefix: "10.9.0.0/16", nexthop: "10.0.0.2", distance: 200 },
  "ospf-interface": { interface: "Gi0/3", area: 0, process: 1 }, "bgp-neighbor": { local: 65100, neighbor: "10.0.0.2", remote: 65200 }, ntp: { server: "10.0.0.9" }, syslog: { host: "10.0.0.8" },
  "interface-state": { interface: "Gi0/4", description: "spare", up: false }, loopback: { number: 9, address: "10.255.0.9/32" }, "ospf-router-id": { routerid: "10.255.0.1" }, vrf: { name: "CUST_A", rd: "65100:10" },
  "port-channel": { id: 1, members: "Gi0/5, Gi0/6", mode: "active", description: "uplink" }, mtu: { interface: "Gi0/7", mtu: 9000 },
  "acl-entry": { name: "GUEST_IN", action: "deny", protocol: "tcp", source: "10.0.0.0/24", destination: "any", port: 22 }, "acl-apply": { interface: "Gi0/8", name: "GUEST_IN", direction: "in" },
  hardening: { ssh2: true, http: true, enc: true, vty: true }, hsrp: { interface: "Gi0/9", group: 1, vip: "10.0.0.254", priority: 110 }, "dhcp-relay": { interface: "Gi0/10", server: "10.0.0.5" },
  dns: { server: "10.0.0.53" }, hostname: { hostname: "edge-1", domain: "example.net" }, "snmp-info": { location: "Frankfurt DC2", contact: "noc@example.net" },
};

describe("what each service says about taking it away", () => {
  it("covers every service: an identity, and either a removal or the reason there is none", () => {
    for (const d of CATALOG) {
      expect(IDENTITY[d.id], `identity of ${d.id}`).toBeDefined();
      expect(isRemovable(d) || notRemovableReason(d.id), d.id).toBeTruthy();
      expect(isRemovable(d), d.id).toBe(notRemovableReason(d.id) === null);
      for (const k of IDENTITY[d.id]) expect(d.fields.map((f) => f.id), `${d.id}.${k}`).toContain(k);
    }
  });

  it("never produces a removal line the safety rules would block, on any platform", () => {
    for (const d of CATALOG.filter(isRemovable)) {
      for (const p of d.platforms) {
        let lines: string[];
        try { lines = removeLines(d, p, ok(d.id, SAMPLE[d.id])); } catch (e) { expect((e as Error).message, `${d.id} on ${p}`).toMatch(/no automatic removal|not available/); continue; }
        expect(lines.length, `${d.id} on ${p}`).toBeGreaterThan(0);
        expect(blockedLines(lines, p), `${d.id} on ${p}`).toEqual([]);
        for (const l of lines) expect(l, `${d.id} on ${p}`).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  it("removes each thing the way its platform expects", () => {
    const rm = (id: string, p: Platform, v: Record<string, string | number | boolean>) => removeLines(def(id), p, ok(id, v));
    expect(rm("vlan", "ios", SAMPLE.vlan)).toEqual(["no vlan 10"]);
    expect(rm("vlan", "junos", SAMPLE.vlan)).toEqual(["delete vlans USERS"]);
    expect(rm("routed-interface", "ios", SAMPLE["routed-interface"])).toEqual(["interface Gi0/3", " no description", " no ip address", " shutdown"]);
    expect(rm("static-route", "ios", { prefix: "10.9.0.0/16", nexthop: "10.0.0.2" })).toEqual(["no ip route 10.9.0.0 255.255.0.0 10.0.0.2"]);
    expect(rm("static-route", "eos", SAMPLE["static-route"])).toEqual(["no ip route 10.9.0.0/16 10.0.0.2 200"]);
    expect(rm("bgp-neighbor", "ios", SAMPLE["bgp-neighbor"])).toEqual(["router bgp 65100", " no neighbor 10.0.0.2 remote-as 65200"]);
    expect(rm("bgp-neighbor", "junos", SAMPLE["bgp-neighbor"])).toEqual(["delete protocols bgp group EXTERNAL neighbor 10.0.0.2"]);
    expect(rm("svi", "nxos", SAMPLE.svi)).toEqual(["no interface Vlan10"]);
    expect(rm("loopback", "ios", SAMPLE.loopback)).toEqual(["no interface Loopback9"]);
    expect(rm("acl-entry", "ios", SAMPLE["acl-entry"])).toEqual(["ip access-list extended GUEST_IN", " no deny tcp 10.0.0.0 0.0.0.255 any eq 22"]);
    expect(rm("acl-entry", "ios", { name: "G", action: "permit", protocol: "ip", seq: 20 })).toEqual(["ip access-list extended G", " no 20"]);
    expect(rm("port-channel", "ios", SAMPLE["port-channel"])).toEqual(["interface Gi0/5", " no channel-group 1", "interface Gi0/6", " no channel-group 1", "no interface Port-channel1"]);
    expect(rm("hsrp", "eos", SAMPLE.hsrp)).toEqual(["interface Gi0/9", " no vrrp 1 ipv4 10.0.0.254", " no vrrp 1 priority-level 110"]);
    expect(rm("ntp", "junos", SAMPLE.ntp)).toEqual(["delete system ntp server 10.0.0.9"]);
  });

  it("refuses to remove what cannot be undone safely, and says why", () => {
    for (const id of ["vrf", "hardening", "hostname", "interface-state", "ospf-router-id"]) {
      expect(isRemovable(def(id)), id).toBe(false);
      expect(() => removeLines(def(id), "ios", ok(id, SAMPLE[id])), id).toThrow(/.{20,}/);
    }
    expect(() => removeLines(def("svi"), "junos", ok("svi", SAMPLE.svi))).toThrow(/not available/);
  });
});

describe("working out the change from one version of a service to the next", () => {
  const platform = (d: string): Platform => (d === "J1" ? "junos" : "ios");
  const before = (id: string, devices = ["R1"]) => ({ values: ok(id, SAMPLE[id]), devices });

  it("overwrites in place when a field that is not part of the identity changes", () => {
    const after = { values: ok("routed-interface", { ...SAMPLE["routed-interface"], description: "to R9" }), devices: ["R1"] };
    const [d] = planModify(def("routed-interface"), before("routed-interface"), after, platform);
    expect(d).toMatchObject({ device: "R1", remove: 0 });
    expect((d as { commands: string[] }).commands).toContain(" description to R9");
  });

  it("removes the old and provisions the new when the identity changes", () => {
    const after = { values: ok("vlan", { id: 20, name: "USERS" }), devices: ["R1"] };
    expect(identityChanged(def("vlan"), before("vlan").values, after.values)).toBe(true);
    const [d] = planModify(def("vlan"), before("vlan"), after, platform);
    expect(d).toMatchObject({ remove: 1, add: 2, commands: ["no vlan 10", "vlan 20", " name USERS"] });
  });

  it("takes the service off a device that is dropped and puts it on one that is added, and leaves one that stays", () => {
    const lines = planModify(def("vlan"), before("vlan", ["R1", "R2"]), { values: before("vlan").values, devices: ["R2", "J1"] }, platform);
    const by = (d: string) => lines.find((l) => l.device === d) as { commands: string[]; remove: number; add: number };
    expect(by("R1")).toMatchObject({ remove: 1, add: 0, commands: ["no vlan 10"] });
    expect(by("R2")).toMatchObject({ remove: 0, add: 2 });
    expect(by("J1")).toMatchObject({ remove: 0, add: 1, commands: ["set vlans USERS vlan-id 10"] });
  });

  it("says so when nothing is different, and reports a device that cannot take the change instead of dropping it", () => {
    expect(() => planModify(def("vlan"), before("vlan"), before("vlan"), platform)).toThrow(/Nothing is different/);
    const v = ok("vrf", { name: "CUST_A" });
    const lines = planModify(def("vrf"), { values: v, devices: ["R1"] }, { values: ok("vrf", { name: "CUST_B" }), devices: ["R1"] }, platform);
    expect(lines[0]).toMatchObject({ device: "R1", error: expect.stringMatching(/VRF/) });
  });

  it("plans a removal for every device, and flags a platform with none", () => {
    const lines = planDecommission(def("svi"), { values: ok("svi", SAMPLE.svi), devices: ["R1", "J1"] }, platform);
    expect(lines[0]).toMatchObject({ device: "R1", commands: ["no interface Vlan10"] });
    expect(lines[1]).toMatchObject({ device: "J1", error: expect.stringMatching(/not available/) });
  });

  it("records which devices and interfaces a service touches, for tracing a failing link to the services it affects", () => {
    expect(touches(def("access-port"), ok("access-port", SAMPLE["access-port"]), ["R1", "R2"])).toEqual([{ device: "R1", interface: "Gi0/1" }, { device: "R2", interface: "Gi0/1" }]);
    expect(touches(def("port-channel"), ok("port-channel", SAMPLE["port-channel"]), ["R1"]).map((t) => t.interface)).toEqual(["Gi0/5", "Gi0/6"]);
    expect(touches(def("vlan"), ok("vlan", SAMPLE.vlan), ["R1"])).toEqual([{ device: "R1", interface: null }]);
  });
});

describe("a service follows its change", () => {
  const verify = (db: ReturnType<typeof boot>, changeId: string, status: "verified" | "failed" | "rejected" | "rolled_back" | "rollback_failed" | "approved" | "deploying") => updateChange(db, changeId, { status });
  /** What a change carries: the engine keeps configuration lines without their indentation. */
  const sent = (c: { plan: { devices: { label: string; commands: string[] }[] } }) => c.plan.devices.map((d) => [d.label, d.commands.map((x) => x.trim())]);
  const make = async (over: Partial<Parameters<typeof createService>[0]> = {}) => createService({ scopeId: SCOPE, serviceId: "vlan", name: "Guest VLAN", values: { id: 110, name: "GUEST" }, devices: ["R1", "R2"], ...over });

  it("remembers a new service, files its change, and stays pending while a person works on it", async () => {
    const db = boot();
    const { service, change } = await make();
    expect(service).toMatchObject({ name: "Guest VLAN", serviceId: "vlan", status: "pending", devices: ["R1", "R2"], applied: null, pending: { changeId: change.id, op: "provision" } });
    expect(change.status).toBe("proposed");
    expect(sent(change)).toEqual([["R1", ["vlan 110", "name GUEST"]], ["R2", ["vlan 110", "name GUEST"]]]);
    verify(db, change.id, "approved");
    verify(db, change.id, "deploying");
    expect(getService(db, service.id)!.status).toBe("pending");
    expect(listAudit(db).some((e) => /Provisioned service "Guest VLAN"/.test(e.summary))).toBe(true);
  });

  it("becomes active when the change is verified, and records what is now on the devices", async () => {
    const db = boot();
    const { service, change } = await make();
    verify(db, change.id, "verified");
    const now = getService(db, service.id)!;
    expect(now).toMatchObject({ status: "active", pending: null, applied: { devices: ["R1", "R2"] } });
    expect(now.history).toEqual([expect.objectContaining({ op: "provision", changeStatus: "verified" })]);
  });

  it("is inactive when its first change is rejected or rolled back, and failed when the change fails", async () => {
    const db = boot();
    const a = await make({ name: "Svc A" });
    const b = await make({ name: "Svc B", values: { id: 111, name: "B" } });
    const c = await make({ name: "Svc C", values: { id: 112, name: "C" } });
    const d = await make({ name: "Svc D", values: { id: 113, name: "D" } });
    verify(db, a.change.id, "rejected");
    verify(db, b.change.id, "rolled_back");
    verify(db, c.change.id, "failed");
    verify(db, d.change.id, "rollback_failed");
    expect(["Svc A", "Svc B", "Svc C", "Svc D"].map((n) => listServices(db, SCOPE).find((s) => s.name === n)!.status)).toEqual(["inactive", "inactive", "failed", "failed"]);
  });

  it("treats a change that was removed from the list as withdrawn", async () => {
    const db = boot();
    const { service, change } = await make();
    updateChange(db, change.id, { status: "rejected" });
    deleteChange(db, change.id);
    expect(getService(db, service.id)!.status).toBe("inactive");
  });

  it("is brought up to date by the scheduler's pass even when nobody reads it", async () => {
    const db = boot();
    const { service, change } = await make();
    verify(db, change.id, "verified");
    reconcileAll(db);
    expect((db.prepare("SELECT status FROM service_instances WHERE id = ?").get(service.id) as { status: string }).status).toBe("active");
  });

  it("changes in place: a modification keeps the old state until it is verified, and goes back to it when rejected", async () => {
    const db = boot();
    const { service, change } = await make({ serviceId: "routed-interface", name: "Uplink", values: { interface: "Gi0/3", address: "10.0.0.1/30" }, devices: ["R1"] });
    verify(db, change.id, "verified");

    const dry = await modifyService(service.id, { values: { description: "to R2" } }, { dryRun: true });
    expect(dry.change).toBeNull();
    expect(dry.plan!.devices[0]).toMatchObject({ remove: 0 });
    expect(getService(db, service.id)!.status).toBe("active"); // a preview changes nothing

    const m = await modifyService(service.id, { values: { description: "to R2" } });
    expect(m.service).toMatchObject({ status: "pending", pending: { op: "modify" }, values: { description: "to R2" }, applied: { values: { interface: "Gi0/3" } } });
    expect(m.service.applied!.values.description).toBeUndefined();
    verify(db, m.change!.id, "rejected");
    expect(getService(db, service.id)).toMatchObject({ status: "active", values: expect.not.objectContaining({ description: "to R2" }) });

    const m2 = await modifyService(service.id, { values: { description: "to R2" } });
    verify(db, m2.change!.id, "verified");
    expect(getService(db, service.id)).toMatchObject({ status: "active", applied: { values: { description: "to R2" } } });
    expect(getService(db, service.id)!.history.map((h) => h.op)).toEqual(["modify", "modify", "provision"]);
  });

  it("swaps the thing in one change when its identity changes, and moves it between devices", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    verify(db, change.id, "verified");
    const m = await modifyService(service.id, { values: { id: 120 }, devices: ["R2"] });
    expect(sent(m.change!)).toEqual([["R1", ["no vlan 110"]], ["R2", ["vlan 120", "name GUEST"]]]);
  });

  it("renames without any change to a device", async () => {
    const db = boot();
    const { service, change } = await make();
    verify(db, change.id, "verified");
    const r = await modifyService(service.id, { name: "Visitors" });
    expect(r.change).toBeNull();
    expect(getService(db, service.id)!.name).toBe("Visitors");
    expect((db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(1);
  });

  it("takes a service away through a change, and retires it once that is verified", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    verify(db, change.id, "verified");
    const dry = await decommissionService(service.id, { dryRun: true });
    expect(dry.change).toBeNull();
    expect(dry.plan.devices[0]).toMatchObject({ commands: ["no vlan 110"] });
    const r = await decommissionService(service.id);
    expect(sent(r.change!)).toEqual([["R1", ["no vlan 110"]]]);
    expect(getService(db, service.id)).toMatchObject({ status: "pending", pending: { op: "decommission" } });
    verify(db, r.change!.id, "verified");
    expect(getService(db, service.id)).toMatchObject({ status: "retired", applied: null });
    expect(listServices(db, SCOPE).map((s) => s.name)).not.toContain("Guest VLAN");
    expect(listServices(db, SCOPE, { includeRetired: true }).map((s) => s.name)).toContain("Guest VLAN");
  });

  it("stays active when its removal is rejected", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    verify(db, change.id, "verified");
    const r = await decommissionService(service.id);
    verify(db, r.change!.id, "rejected");
    expect(getService(db, service.id)).toMatchObject({ status: "active", applied: { devices: ["R1"] } });
  });

  it("retries a failed service by filing a new change, and is active when that verifies", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    verify(db, change.id, "failed");
    const r = await retryService(service.id);
    expect(r.change!.id).not.toBe(change.id);
    expect(sent(r.change!)).toEqual([["R1", ["vlan 110", "name GUEST"]]]);
    verify(db, r.change!.id, "verified");
    expect(getService(db, service.id)!.status).toBe("active");
  });

  it("stops tracking a service without touching a device", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    expect(() => forgetService(service.id)).toThrow(/still open/);
    verify(db, change.id, "verified");
    forgetService(service.id);
    expect(getService(db, service.id)).toBeNull();
    expect(listAudit(db)[0].summary).toMatch(/nothing was changed on any device/);
    expect(getChange(db, change.id)).not.toBeNull();
  });

  it("refuses what the service's state does not allow", async () => {
    const db = boot();
    const { service, change } = await make({ devices: ["R1"] });
    const msg = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof ServiceError ? `${e.status} ${e.message}` : String(e); } };
    expect(await msg(modifyService(service.id, { values: { name: "X" } }))).toMatch(/^409 .*still open/); // a change is open
    expect(await msg(decommissionService(service.id))).toMatch(/^409 .*still open/);
    verify(db, change.id, "rejected");
    expect(await msg(modifyService(service.id, { values: { name: "X" } }))).toMatch(/^409 .*inactive/);
    expect(await msg(decommissionService(service.id))).toMatch(/^409 .*never applied/);
    const r = await retryService(service.id);
    verify(db, r.change!.id, "verified");
    expect(await msg(retryService(service.id))).toMatch(/^409 .*failed or never-applied/);
    const v = await createService({ scopeId: SCOPE, serviceId: "vrf", name: "Cust", values: { name: "CUST_A" }, devices: ["R1"] });
    verify(db, v.change.id, "verified");
    expect(await msg(decommissionService(v.service.id))).toMatch(/^409 .*Removing a VRF/);
    expect(await msg(modifyService("nope", {}))).toMatch(/^404/);
  });

  it("refuses a bad request without leaving a service or a change behind", async () => {
    const db = boot();
    const msg = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof ServiceError ? `${e.status} ${e.message}` : String(e); } };
    expect(await msg(make({ name: "x" }))).toMatch(/^400 .*name/);
    expect(await msg(make({ values: { id: 99999, name: "G" } }))).toMatch(/^400 .*VLAN id/);
    expect(await msg(make({ devices: ["ghost"] }))).toMatch(/^404 .*ghost/);
    expect(await msg(createService({ scopeId: SCOPE, serviceId: "svi", name: "Svi", values: { vlan: 10, address: "10.0.0.1/24" }, devices: ["J1"] }))).toMatch(/^400 .*not available for junos/);
    expect(await msg(createService({ scopeId: SCOPE, serviceId: "nope", name: "N", values: {}, devices: ["R1"] }))).toMatch(/^404/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM service_instances").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(0);
    await make();
    expect(await msg(make({ name: "guest vlan", values: { id: 5, name: "Z" } }))).toMatch(/^409 .*already exists/);
  });

  it("tells webhook receivers when a service is created and when it settles", async () => {
    const db = boot();
    createWebhook(db, { name: "ci", url: "https://hooks.example.com/x", events: ["service.created", "service.active", "service.retired"] });
    const { service, change } = await make({ devices: ["R1"] });
    verify(db, change.id, "verified");
    getService(db, service.id);
    const r = await decommissionService(service.id);
    verify(db, r.change!.id, "verified");
    getService(db, service.id);
    expect((db.prepare("SELECT event FROM webhook_deliveries ORDER BY rowid").all() as { event: string }[]).map((x) => x.event)).toEqual(["service.created", "service.active", "service.retired"]);
    expect(listDeliveries(db, null)[0].event).toBe("service.retired");
  });
});

describe("services over the API", () => {
  const call = (handler: unknown, path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}, params: Record<string, string> = {}) => {
    const headers: Record<string, string> = { host: "tinysnitch.corp.example:3000", ...(init.headers ?? {}) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://${headers.host}${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
    return (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) });
  };
  const j = async (r: Response) => (await r.json()) as Record<string, any>;

  it("provisions, lists, reads, previews a change and stops tracking, each by the role it needs", async () => {
    const db = boot();
    const viewer = createApiToken(db, { name: "v", role: "viewer" }).token;
    const operator = createApiToken(db, { name: "o", role: "operator" }).token;
    const approver = createApiToken(db, { name: "a", role: "approver" }).token;
    const body = { scopeId: SCOPE, serviceId: "vlan", name: "Guest VLAN", values: { id: 110, name: "GUEST" }, devices: ["R1"] };

    expect((await call(v1Post, "/api/v1/services", { token: viewer, body })).status).toBe(403);
    const made = await call(v1Post, "/api/v1/services", { token: operator, body, headers: { "idempotency-key": "k1" } });
    expect(made.status).toBe(201);
    const { service } = await j(made);
    const again = await call(v1Post, "/api/v1/services", { token: operator, body, headers: { "idempotency-key": "k1" } });
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect((db.prepare("SELECT COUNT(*) AS n FROM service_instances").get() as { n: number }).n).toBe(1);

    const list = await j(await call(v1Get, `/api/v1/services?scope=${SCOPE}`, { token: viewer }));
    expect(list.services.map((s: { name: string }) => s.name)).toEqual(["Guest VLAN"]);
    expect((await j(await call(v1One, `/api/v1/services/${service.id}`, { token: viewer }, { id: service.id }))).history).toHaveLength(1);
    expect((await call(v1One, "/api/v1/services/none", { token: viewer }, { id: "none" })).status).toBe(404);

    updateChange(db, service.pending.changeId, { status: "verified" });
    const dry = await j(await call(v1Put, `/api/v1/services/${service.id}`, { token: operator, method: "PUT", body: { values: { name: "VISITORS" }, dryRun: true } }, { id: service.id }));
    expect(dry.change).toBeNull();
    expect(dry.plan.devices[0].commands).toEqual(["vlan 110", " name VISITORS"]);
    expect((await call(v1Put, `/api/v1/services/${service.id}`, { token: viewer, method: "PUT", body: { values: { name: "V" } } }, { id: service.id })).status).toBe(403);

    expect((await call(v1Delete, `/api/v1/services/${service.id}`, { token: operator, method: "DELETE", body: {} }, { id: service.id })).status).toBe(403);
    expect((await call(v1Delete, `/api/v1/services/${service.id}`, { token: approver, method: "DELETE", body: {} }, { id: service.id })).status).toBe(200);
    expect(getService(db, service.id)).toBeNull();
  });
});
