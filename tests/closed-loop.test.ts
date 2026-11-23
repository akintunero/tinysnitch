import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST as fixPost } from "@/app/api/findings/[id]/fix/route";
import { POST as v1Fix } from "@/app/api/v1/findings/[id]/fix/route";
import { createApiToken } from "@/lib/api/tokens";
import { getChange, updateChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { listAudit } from "@/lib/database/repo";
import { baseline } from "@/lib/diagnostics/checks-extra";
import { FixError, fixChangesFor, proposeFix } from "@/lib/diagnostics/fix";
import { saveRun } from "@/lib/diagnostics/store";
import type { Finding, RunSummary } from "@/lib/diagnostics/types";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";

describe("fixes stated by the security baseline", () => {
  const config = "hostname R1\nip http server\nline con 0\nline vty 0 4\n login local\n transport input telnet\n";
  const hits = baseline(config);
  const fixOf = (kind: string) => hits.find((h) => h.kind === kind)?.fix;

  it("pins SSH to version 2, turns the HTTP server off and allows only SSH on the VTY lines", () => {
    expect(fixOf("hygiene-ssh-v2")).toMatchObject({ commands: ["ip ssh version 2"] });
    expect(fixOf("hygiene-http-server")).toMatchObject({ commands: ["no ip http server"], note: expect.stringContaining("web interface") });
    expect(fixOf("hygiene-telnet")).toMatchObject({ commands: ["line vty 0 4", "transport input ssh"], note: expect.stringContaining("cut off") });
  });

  it("gives no fix where the right answer depends on something only a person knows", () => {
    const noisy = baseline("hostname R1\nsnmp-server community public RO\nenable password 7 0822455D0A16\nusername bob password 0 x\n");
    for (const k of ["hygiene-snmp-default", "hygiene-enable-password", "hygiene-username-password", "hygiene-ntp", "hygiene-logging", "hygiene-aaa"]) {
      const h = noisy.find((x) => x.kind === k);
      expect(h, k).toBeDefined();
      expect(h!.fix, k).toBeUndefined();
    }
  });

  it("states a fix for the telnet default as well, since the fix is the same lines", () => {
    const d = baseline("hostname R1\nline vty 0 4\n login local\n").find((h) => h.kind === "hygiene-telnet-default");
    expect(d?.fix?.commands).toEqual(["line vty 0 4", "transport input ssh"]);
  });
});

describe("filing a finding's fix as a change", () => {
  const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
  afterEach(() => { setContext(undefined); setProviders(null); });

  function boot() {
    process.env.TS_FIX_PW = "x";
    const file = join(mkdtempSync(join(tmpdir(), "ts-fix-")), "inv.yaml");
    writeFileSync(file, "credentials:\n  c: { username: admin, password: env:TS_FIX_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: 1, platform: ios }\n      - { name: R2, address: 127.0.0.2, port: 1, platform: ios }\n");
    const db = openDatabase(":memory:");
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "x", lastConnectAttempt: 0, llm: null, claude });
    setProviders([new StaticProvider(file)]);
    return db;
  }
  const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
    id, kind: "bgp-as-mismatch", severity: "critical", status: "confirmed", device: "R1", deviceId: "r1", interface: null, peer: null, linkId: null,
    title: "BGP peer 10.0.15.2 is set to AS 65201, but R2 runs AS 65200", description: "d", evidence: [], probableCause: "", recommendedAction: "", verification: "",
    fix: { summary: "Set neighbor 10.0.15.2 to remote-as 65200 on R1", note: "This sets the AS on R1. If R2 is the one with the wrong AS, change that instead.", commands: ["router bgp 65100", "neighbor 10.0.15.2 remote-as 65200"] },
    ...over,
  });
  const run = (id: string): RunSummary => ({ id, labId: "static:s", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", devices: [{ nodeId: "r1", label: "R1", kind: "router", inspected: true, reason: null, commandsRun: 4, commandsFailed: 0 }], interfaces: {}, pings: [], notRun: [] });
  const msg = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof FixError ? `${e.status} ${e.message}` : String(e); } };

  it("proposes the stated lines on the finding's device, and never applies them", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("f1")]);
    const r = await proposeFix("f1");
    expect(r.change.status).toBe("proposed");
    expect(r.change.title).toMatch(/^Fix: BGP peer 10\.0\.15\.2/);
    expect(r.change.plan.devices.map((d) => [d.label, d.commands])).toEqual([["R1", ["router bgp 65100", "neighbor 10.0.15.2 remote-as 65200"]]]);
    expect(r.change.intent).toContain("bgp-as-mismatch");
    expect(getChange(db, r.change.id)!.approvedAt).toBeNull();
    expect(listAudit(db).some((e) => /Filed a fix for finding/.test(e.summary))).toBe(true);
  });

  it("remembers the fix against the finding and follows its change", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("f1")]);
    const { change } = await proposeFix("f1");
    expect(fixChangesFor(db, "static:s").f1).toEqual([expect.objectContaining({ changeId: change.id, status: "proposed" })]);
    updateChange(db, change.id, { status: "verified" });
    expect(fixChangesFor(db, "static:s").f1[0].status).toBe("verified");
    expect(fixChangesFor(db, "static:other")).toEqual({});
  });

  it("does not file a second fix on top of an open one, but allows another once that is settled", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("f1")]);
    const first = await proposeFix("f1");
    expect(await msg(proposeFix("f1"))).toMatch(/^409 .*already open/);
    updateChange(db, first.change.id, { status: "rejected" });
    const second = await proposeFix("f1");
    expect(second.change.id).not.toBe(first.change.id);
    expect(fixChangesFor(db, "static:s").f1.map((c) => c.status)).toEqual(["proposed", "rejected"]);
  });

  it("refuses a finding that has no fix, has cleared, or does not exist", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("plain", { fix: undefined, kind: "mask-mismatch" }), finding("f1")]);
    expect(await msg(proposeFix("plain"))).toMatch(/^409 .*no fix/);
    saveRun(db, run("r2"), []); // nothing found: both clear
    expect(await msg(proposeFix("f1"))).toMatch(/^409 .*cleared/);
    expect(await msg(proposeFix("nope"))).toMatch(/^404/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(0);
  });

  it("is refused, not guessed at, when the change engine rejects the lines", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("bad", { fix: { summary: "x", note: null, commands: ["reload"] } })]);
    expect(await msg(proposeFix("bad"))).toMatch(/^4\d\d /);
    expect((db.prepare("SELECT COUNT(*) AS n FROM finding_fixes").get() as { n: number }).n).toBe(0);
  });

  it("is on the API for an operator and not for a viewer", async () => {
    const db = boot();
    saveRun(db, run("r1"), [finding("f1")]);
    const viewer = createApiToken(db, { name: "v", role: "viewer" }).token;
    const operator = createApiToken(db, { name: "o", role: "operator" }).token;
    const call = (h: unknown, token: string) => (h as (r: Request, c: unknown) => Promise<Response>)(new Request("http://tinysnitch.corp.example:3000/api/v1/findings/f1/fix", { method: "POST", headers: { host: "tinysnitch.corp.example:3000", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: "f1" }) });
    expect((await call(v1Fix, viewer)).status).toBe(403);
    const ok = await call(v1Fix, operator);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ change: { status: "proposed" }, finding: { id: "f1", device: "R1" } });
    expect((await call(fixPost, operator)).status).toBe(409); // already open
  });
});
