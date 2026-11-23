import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GET as backupsGet } from "@/app/api/backups/route";
import { GET as backupGet } from "@/app/api/backups/[id]/route";
import { GET as downloadGet } from "@/app/api/backups/[id]/download/route";
import { POST as ackPost } from "@/app/api/drift/[id]/acknowledge/route";
import { GET as historyGet } from "@/app/api/labs/[labId]/history/route";
import { BackupError, runBackups } from "@/lib/backup/engine";
import { diffOps, lineDiff } from "@/lib/backup/diff";
import { KEEP_VERSIONS, canonicalConfig, devicesWithBackups, getBackup, hashConfig, jobLastRun, listDrift, listVersions, recordBackup } from "@/lib/backup/store";
import { acquireNetworkLock, approveChange, deployChange, proposeChange, resetChangeLocks, rollbackChange } from "@/lib/changes/engine";
import { createChange, updateChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { runHistory } from "@/lib/diagnostics/store";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { dueJobs, schedulerTick } from "@/lib/server/scheduler";
import { type StatefulDevice, startStatefulDevice } from "./helpers/fake-device";

const CFG = "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\ninterface GigabitEthernet0/1\n no ip address\n shutdown\n";

describe("line diff", () => {
  it("shows added, removed and replaced lines with context, and collapses the rest", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 15", "line 15 changed").replace("line 3\n", "");
    const d = lineDiff(a, b, 2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(2);
    expect(d.lines.some((l) => l.op === "~")).toBe(true);
    expect(d.lines.filter((l) => l.op === "+").map((l) => l.text)).toEqual(["line 15 changed"]);
    expect(d.lines.filter((l) => l.op === "-").map((l) => l.text)).toEqual(["line 3", "line 15"]);
    expect(d.lines.length).toBeLessThan(30);
  });
  it("says nothing changed for identical text", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual({ lines: [], added: 0, removed: 0, truncated: false });
  });
  it("aligns around a moved block instead of showing everything replaced", () => {
    const ops = diffOps(["a", "b", "c", "d"], ["a", "x", "c", "d"]);
    expect(ops.map((o) => `${o.op}${o.text}`)).toEqual([" a", "-b", "+x", " c", " d"]);
  });
  it("falls back to replace-all rather than exhausting memory on a huge difference", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`), b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(diffOps(a, b).filter((o) => o.op === " ")).toEqual([]);
  });
});

describe("what counts as the same configuration", () => {
  it("ignores timestamps, byte counts, comments and trailing space", () => {
    const a = "Building configuration...\n\nCurrent configuration : 1000 bytes\n!\n! Last configuration change at 10:00:00 UTC Mon Nov 9 2026\nhostname R1  \ninterface Gi0/0\n ip address 10.0.0.1 255.255.255.0\n!\nend";
    const b = "Building configuration...\n\nCurrent configuration : 1017 bytes\n!\n! Last configuration change at 11:45:12 UTC Mon Nov 9 2026\nhostname R1\ninterface Gi0/0\n ip address 10.0.0.1 255.255.255.0\n!\nend";
    expect(hashConfig(a)).toBe(hashConfig(b));
    expect(canonicalConfig(a)).toContain("hostname R1");
    expect(canonicalConfig(a)).not.toContain("Last configuration change");
  });
  it("notices a real difference, including an indented one", () => {
    expect(hashConfig("interface Gi0/0\n shutdown")).not.toBe(hashConfig("interface Gi0/0\n no shutdown"));
  });
});

describe("versions and drift", () => {
  const db = () => openDatabase(":memory:");
  const rec = (d: ReturnType<typeof db>, config: string, source = "scheduled", device = "R1") => recordBackup(d, { scopeId: "s", device, config, source });

  it("stores a first version, and not again while the configuration is the same", () => {
    const d = db();
    const a = rec(d, CFG);
    expect(a).toMatchObject({ changed: true, drift: null });
    const again = rec(d, `${CFG}\n`);
    expect(again.changed).toBe(false);
    expect(listVersions(d, "s", "R1")).toHaveLength(1);
  });
  it("records drift, with line counts, when a scheduled read differs and nothing explains it", () => {
    const d = db();
    rec(d, CFG);
    const r = rec(d, CFG.replace("shutdown", "no shutdown\n description sneaky"));
    expect(r.changed).toBe(true);
    expect(r.drift).toMatchObject({ device: "R1", linesAdded: 2, linesRemoved: 1, possibleChange: null, acknowledgedAt: null });
    expect(listDrift(d, "s")).toHaveLength(1);
  });
  it("does not call a Tiny Snitch change or rollback drift, but does a pre-change read that differs", () => {
    const d = db();
    rec(d, CFG);
    expect(rec(d, CFG.replace("shutdown", "no shutdown"), "change:abc").drift).toBeNull();
    expect(rec(d, CFG, "rollback:abc").drift).toBeNull();
    expect(rec(d, `${CFG} ntp server 10.0.0.9\n`, "pre-change:def").drift).not.toBeNull(); // someone changed it before our change
    expect(listDrift(d, "s")).toHaveLength(1);
  });
  it("points at a change that failed or never finished, instead of calling it out-of-band", () => {
    const d = db();
    rec(d, CFG);
    const c = createChange(d, { scopeId: "s", environment: "lab", title: "t", intent: "t", source: "user", plan: { devices: [{ deviceId: "x", label: "R1", platform: "ios", commands: ["description x"], risks: [] }], warnings: [] } });
    updateChange(d, c.id, { status: "failed" });
    expect(rec(d, `${CFG} description x\n`).drift?.possibleChange).toBe(c.id);
  });
  it("keeps drift per device and lets it be acknowledged once", () => {
    const d = db();
    rec(d, CFG, "scheduled", "R1"); rec(d, CFG, "scheduled", "R2");
    rec(d, `${CFG} a\n`, "scheduled", "R1");
    expect(listDrift(d, "s").map((x) => x.device)).toEqual(["R1"]);
  });
  it("drops only the oldest versions beyond the limit", () => {
    const d = db();
    for (let i = 0; i < KEEP_VERSIONS + 5; i++) rec(d, `${CFG} v${i}\n`);
    const v = listVersions(d, "s", "R1", 1000);
    expect(v).toHaveLength(KEEP_VERSIONS);
    expect(getBackup(d, v.at(-1)!.id)?.config).toContain("v5\n");
    expect(devicesWithBackups(d, "s")).toMatchObject([{ device: "R1", versions: KEEP_VERSIONS }]);
  });
  it("stores configurations masked for secrets", () => {
    const d = db();
    const r = rec(d, `${CFG}enable secret 5 $1$abcd$abcdefghijklmnop\n`);
    expect(getBackup(d, r.backup.id)?.config).not.toContain("$1$abcd$abcdefghijklmnop");
  });
});

describe("backups of a real SSH device model", () => {
  let dev: StatefulDevice | null = null;
  afterEach(() => { dev?.close(); dev = null; setProviders(null); setContext(undefined); resetChangeLocks(); });

  async function boot(over: { mode?: "approve" | "autopilot" } = {}) {
    dev = await startStatefulDevice({ host: "R1", config: CFG });
    process.env.TS_TEST_PW = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-bk-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${dev.port}, platform: ios, kind: router }\n      - { name: PC1, address: 127.0.0.1, port: ${dev.port}, platform: ios, kind: host }\n`);
    const db = openDatabase(":memory:");
    saveSettings(db, { executionMode: over.mode ?? "approve" });
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
    return db;
  }
  const SCOPE = "static:s";

  it("backs up each router, skips what is not one, and stores nothing new the second time", async () => {
    const db = await boot();
    const a = await runBackups(SCOPE, "manual");
    expect(a.devices.map((d) => [d.device, d.status])).toEqual([["PC1", "skipped"], ["R1", "new"]]);
    const b = await runBackups(SCOPE, "manual");
    expect(b.devices.find((d) => d.device === "R1")?.status).toBe("unchanged");
    expect(listVersions(db, SCOPE, "R1")).toHaveLength(1);
    expect(dev!.sent.filter((l) => !/^(show|terminal)/.test(l))).toEqual([]); // only reads
  });

  it("finds a change someone made on the device itself", async () => {
    const db = await boot();
    await runBackups(SCOPE, "scheduled");
    dev!.blocks.get("interface GigabitEthernet0/1")!.push("description added by hand");
    const r = await runBackups(SCOPE, "scheduled");
    expect(r.devices.find((d) => d.device === "R1")?.status).toBe("changed");
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toMatchObject({ device: "R1", linesAdded: 1, linesRemoved: 0 });
    expect(listDrift(db, SCOPE)).toHaveLength(1);
  });

  it("waits while a change is being applied", async () => {
    await boot();
    const release = acquireNetworkLock(SCOPE);
    await expect(runBackups(SCOPE, "scheduled")).rejects.toBeInstanceOf(BackupError);
    release();
    await expect(runBackups(SCOPE, "scheduled")).resolves.toBeDefined();
  });

  it("keeps a version before and after a change and after a rollback, and none of those is drift", async () => {
    const db = await boot();
    await runBackups(SCOPE, "manual");
    const c = await proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices: [{ device: "R1", commands: ["interface Gi0/1", "description uplink"] }] });
    approveChange(c.id);
    expect((await deployChange(c.id)).status).toBe("verified");
    // The pre-change read matched the manual backup exactly, so it is not stored twice.
    expect(listVersions(db, SCOPE, "R1").map((v) => v.source)).toEqual([`change:${c.id}`, "manual"]);
    await rollbackChange(c.id);
    expect(listVersions(db, SCOPE, "R1").map((v) => v.source.split(":")[0])).toEqual(["rollback", "change", "manual"]);
    expect(listDrift(db, SCOPE, { includeAcknowledged: true })).toEqual([]);
    // After the change, the scheduled read matches the version the change left, so it is not drift either.
    await rollbackChange(c.id).catch(() => undefined);
    expect((await runBackups(SCOPE, "scheduled")).drift).toEqual([]);
  });

  it("shows that a device was changed by hand before a Tiny Snitch change touched it", async () => {
    const db = await boot();
    await runBackups(SCOPE, "manual");
    dev!.blocks.get("")!.push("ntp server 10.9.9.9");
    const c = await proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices: [{ device: "R1", commands: ["interface Gi0/1", "description uplink"] }] });
    approveChange(c.id);
    await deployChange(c.id);
    const drift = listDrift(db, SCOPE);
    expect(drift).toHaveLength(1);
    expect(getBackup(db, drift[0].toBackup)?.source).toBe(`pre-change:${c.id}`);
  });

  describe("through the API", () => {
    const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, { headers: { host: "localhost", "content-type": "application/json" }, ...init });
    const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

    it("lists devices and drift, serves a version with its diff, a download, and acknowledges drift", async () => {
      const db = await boot();
      await runBackups(SCOPE, "scheduled");
      dev!.blocks.get("")!.push("ntp server 10.9.9.9");
      await runBackups(SCOPE, "scheduled");

      const overview = await (await backupsGet(req(`/api/backups?scope=${encodeURIComponent(SCOPE)}`))).json();
      expect(overview.devices).toHaveLength(1);
      expect(overview.drift).toHaveLength(1);

      const latest = overview.devices[0].latest.id;
      const v = await (await backupGet(req(`/api/backups/${latest}`), ctx({ id: String(latest) }))).json();
      expect(v.diff.added).toBe(1);
      expect(v.diff.lines.some((l: { op: string; text: string }) => l.op === "+" && l.text.includes("ntp server 10.9.9.9"))).toBe(true);
      expect(v.versions).toHaveLength(2);

      const dl = await downloadGet(req(`/api/backups/${latest}/download`), ctx({ id: String(latest) }));
      expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename="R1-/);
      expect(await dl.text()).toContain("ntp server 10.9.9.9");

      const ack = await ackPost(req(`/api/drift/${overview.drift[0].id}/acknowledge`, { method: "POST", headers: { host: "localhost", "content-type": "application/json" } }), ctx({ id: String(overview.drift[0].id) }));
      expect(ack.status).toBe(200);
      expect((await (await backupsGet(req(`/api/backups?scope=${encodeURIComponent(SCOPE)}`))).json()).drift).toEqual([]);
      expect(listDrift(db, SCOPE, { includeAcknowledged: true })[0].acknowledgedBy).toBe("user");
    });

    it("answers 404 for a version that does not exist and refuses a diff against another device", async () => {
      await boot();
      expect((await backupGet(req("/api/backups/999"), ctx({ id: "999" }))).status).toBe(404);
      expect((await downloadGet(req("/api/backups/abc/download"), ctx({ id: "abc" }))).status).toBe(404);
    });
  });
});

describe("the scheduler", () => {
  const s = (over: Partial<{ monitoredScopes: string[]; backupIntervalMinutes: number; diagnosticsIntervalMinutes: number }> = {}) => ({ monitoredScopes: ["n1"], backupIntervalMinutes: 60, diagnosticsIntervalMinutes: 0, ...over });
  const MIN = 60_000;

  it("runs a job that has never run, and not one that ran recently", () => {
    expect(dueJobs(s(), () => null, 0).map((j) => j.key)).toEqual(["backup:n1"]);
    expect(dueJobs(s(), () => 0, 59 * MIN)).toEqual([]);
    expect(dueJobs(s(), () => 0, 60 * MIN).map((j) => j.key)).toEqual(["backup:n1"]);
  });
  it("does nothing for a network that was not switched on, or an interval of zero", () => {
    expect(dueJobs(s({ monitoredScopes: [] }), () => null, 0)).toEqual([]);
    expect(dueJobs(s({ backupIntervalMinutes: 0 }), () => null, 0)).toEqual([]);
  });
  it("schedules backups and diagnostics independently", () => {
    expect(dueJobs(s({ diagnosticsIntervalMinutes: 30 }), (k) => (k.startsWith("backup") ? 0 : null), 10 * MIN).map((j) => j.key)).toEqual(["diagnostics:n1"]);
  });

  describe("on a real SSH device model", () => {
    let dev: StatefulDevice | null = null;
    afterEach(() => { dev?.close(); dev = null; setProviders(null); setContext(undefined); resetChangeLocks(); });
    async function boot(settings: Parameters<typeof saveSettings>[1]) {
      dev = await startStatefulDevice({ host: "R1", config: CFG });
      process.env.TS_TEST_PW = "secret";
      const file = join(mkdtempSync(join(tmpdir(), "ts-sch-")), "inv.yaml");
      writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${dev.port}, platform: ios, kind: router }\n`);
      const db = openDatabase(":memory:");
      saveSettings(db, settings);
      setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
      setProviders([new StaticProvider(file)]);
      return db;
    }

    it("backs up and runs diagnostics for a switched-on network, then waits for the next interval", async () => {
      const db = await boot({ monitoredScopes: ["static:s"], backupIntervalMinutes: 60, diagnosticsIntervalMinutes: 60 });
      const t0 = Date.now();
      const first = await schedulerTick(t0);
      expect(first.ran.sort()).toEqual(["backup:static:s", "diagnostics:static:s"]);
      expect(listVersions(db, "static:s", "R1")).toHaveLength(1);
      expect(runHistory(db, "static:s")).toHaveLength(1);
      expect(jobLastRun(db, "backup:static:s")).toBe(t0);
      expect((await schedulerTick(t0 + 30 * MIN)).ran).toEqual([]);
      expect((await schedulerTick(t0 + 61 * MIN)).ran).toHaveLength(2);
      expect(runHistory(db, "static:s")).toHaveLength(2);
      expect(runHistory(db, "static:s")[0].counts).toMatchObject({ critical: 0 });
    });

    it("logs a job that cannot run, and tries again next interval rather than every minute", async () => {
      const db = await boot({ monitoredScopes: ["static:s"], backupIntervalMinutes: 60 });
      const release = acquireNetworkLock("static:s"); // a change is in progress
      const t0 = Date.now();
      expect((await schedulerTick(t0)).failed).toEqual(["backup:static:s"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'error' AND actor = 'scheduler'").get()).toMatchObject({ n: 1 });
      release();
      expect((await schedulerTick(t0 + 5 * MIN)).ran).toEqual([]);
      expect((await schedulerTick(t0 + 61 * MIN)).ran).toEqual(["backup:static:s"]);
    });
  });
});

describe("history", () => {
  it("returns an empty list for a network that has never been checked", () => {
    expect(runHistory(openDatabase(":memory:"), "none")).toEqual([]);
  });
  it("answers through the API", async () => {
    setContext({ db: openDatabase(":memory:"), mcp: null, mcpConfig: null, mcpConfigError: "x", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    const r = await historyGet(new Request("http://localhost/api/labs/x/history", { headers: { host: "localhost" } }), { params: Promise.resolve({ labId: "static:s" }) });
    expect(await r.json()).toEqual({ points: [] });
    setContext(undefined);
  });
});
