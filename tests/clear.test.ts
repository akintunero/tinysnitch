import { afterEach, describe, expect, it } from "vitest";
import { DELETE as activityDelete, GET as activityGet } from "@/app/api/activity/route";
import { DELETE as backupDelete } from "@/app/api/backups/[id]/route";
import { POST as clearPost } from "@/app/api/changes/clear/route";
import { DELETE as changeDelete } from "@/app/api/changes/[id]/route";
import { DELETE as conversationsDelete } from "@/app/api/conversations/route";
import { DELETE as diagnosticsDelete } from "@/app/api/labs/[labId]/diagnostics/route";
import { clearConversations, createConversation, listConversations } from "@/lib/assistant/history";
import { getBackup, listDrift, recordBackup } from "@/lib/backup/store";
import { createChange, getChange, updateChange, type ChangeStatus } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { addAudit, listAudit, saveSettings } from "@/lib/database/repo";
import { latestRun, saveRun } from "@/lib/diagnostics/store";
import type { RunSummary } from "@/lib/diagnostics/types";
import { setContext } from "@/lib/server/context";

const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
function boot() {
  const db = openDatabase(":memory:");
  setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "x", lastConnectAttempt: 0, llm: null, claude });
  return db;
}
afterEach(() => setContext(undefined));

const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, { headers: { host: "localhost", "content-type": "application/json" }, ...init });
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const plan = { devices: [], warnings: [] };
const change = (db: ReturnType<typeof boot>, scopeId: string, status: ChangeStatus, title = status) => {
  const c = createChange(db, { scopeId, environment: "lab", title, intent: "", source: "user", plan });
  return status === "proposed" ? c : updateChange(db, c.id, { status });
};

describe("deleting changes", () => {
  it("removes a settled change, and says so in the activity log", async () => {
    const db = boot();
    const c = change(db, "s", "verified");
    const r = await changeDelete(req(`/api/changes/${c.id}`, { method: "DELETE", body: "{}" }), ctx({ id: c.id }));
    expect(r.status).toBe(200);
    expect(getChange(db, c.id)).toBeNull();
    expect(listAudit(db)[0]).toMatchObject({ kind: "configuration", summary: expect.stringContaining("Deleted change") });
  });

  it.each(["approved", "deploying", "paused", "rolling_back"] as const)("refuses a change that is %s, because it is still in flight", async (status) => {
    const db = boot();
    const c = change(db, "s", status);
    const r = await changeDelete(req(`/api/changes/${c.id}`, { method: "DELETE", body: "{}" }), ctx({ id: c.id }));
    expect(r.status).toBe(409);
    expect(getChange(db, c.id)).not.toBeNull();
  });

  it("lets a failed or half-undone change go, since the person is told its snapshot goes too", async () => {
    const db = boot();
    for (const s of ["failed", "rollback_failed"] as const) {
      const c = change(db, "s", s);
      expect((await changeDelete(req(`/api/changes/${c.id}`, { method: "DELETE", body: "{}" }), ctx({ id: c.id }))).status).toBe(200);
    }
  });

  it("answers 404 for a change that is not there", async () => {
    boot();
    expect((await changeDelete(req("/api/changes/nope", { method: "DELETE", body: "{}" }), ctx({ id: "nope" }))).status).toBe(404);
  });

  it("clears only the settled changes of one network and leaves everything else", async () => {
    const db = boot();
    const gone = [change(db, "a", "verified"), change(db, "a", "rolled_back"), change(db, "a", "rejected")];
    const kept = [change(db, "a", "proposed"), change(db, "a", "failed"), change(db, "a", "rollback_failed"), change(db, "a", "paused"), change(db, "a", "approved"), change(db, "b", "verified")];
    const r = await clearPost(req("/api/changes/clear", { method: "POST", body: JSON.stringify({ scopeId: "a" }) }), ctx({}));
    expect(await r.json()).toEqual({ removed: 3 });
    for (const c of gone) expect(getChange(db, c.id)).toBeNull();
    for (const c of kept) expect(getChange(db, c.id), c.status).not.toBeNull();
    expect(listAudit(db)[0].summary).toContain("Cleared 3 finished changes");
  });
});

describe("deleting backups", () => {
  const CFG = (n: number) => `hostname R1\ninterface Gi0/0\n ip address 10.0.0.${n} 255.255.255.0\n`;
  const record = (db: ReturnType<typeof boot>, n: number) => recordBackup(db, { scopeId: "s", device: "R1", config: CFG(n), source: "manual", now: new Date(Date.UTC(2026, 0, n)) });

  it("deletes an older version and the drift events that point at it, but never the newest", async () => {
    const db = boot();
    const first = record(db, 1);
    const second = record(db, 2);
    const third = record(db, 3);
    const id = (r: typeof first) => (r as { backup: { id: number } }).backup.id;
    expect(listDrift(db, "s", { includeAcknowledged: true }).length).toBeGreaterThan(0);

    const newest = await backupDelete(req(`/api/backups/${id(third)}`, { method: "DELETE", body: "{}" }), ctx({ id: String(id(third)) }));
    expect(newest.status).toBe(409);
    expect(getBackup(db, id(third))).not.toBeNull();

    const old = await backupDelete(req(`/api/backups/${id(second)}`, { method: "DELETE", body: "{}" }), ctx({ id: String(id(second)) }));
    expect(old.status).toBe(200);
    expect(getBackup(db, id(second))).toBeNull();
    expect(getBackup(db, id(first))).not.toBeNull();
    expect(listDrift(db, "s", { includeAcknowledged: true }).some((d) => d.fromBackup === id(second) || d.toBackup === id(second))).toBe(false);
    expect(listAudit(db)[0]).toMatchObject({ kind: "backup", summary: expect.stringContaining("Deleted a stored version of R1") });
  });

  it("answers 404 for a version that is not there", async () => {
    boot();
    expect((await backupDelete(req("/api/backups/999", { method: "DELETE", body: "{}" }), ctx({ id: "999" }))).status).toBe(404);
  });
});

describe("clearing diagnostics and conversations", () => {
  const run = (lab: string, id: string): RunSummary => ({ id, labId: lab, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", devices: [], interfaces: {}, pings: [], notRun: [] });

  it("forgets one network's runs and findings, not another's", async () => {
    const db = boot();
    saveRun(db, run("a", "r1"), []);
    saveRun(db, run("b", "r2"), []);
    const r = await diagnosticsDelete(req("/api/labs/a/diagnostics", { method: "DELETE", body: "{}" }), ctx({ labId: "a" }));
    expect(r.status).toBe(200);
    expect(latestRun(db, "a")).toBeNull();
    expect(latestRun(db, "b")).not.toBeNull();
    expect(listAudit(db)[0].kind).toBe("diagnostic");
  });

  it("deletes the conversations of the selected network only", async () => {
    const db = boot();
    saveSettings(db, { selectedLabId: "a" });
    createConversation(db, "a", "one");
    createConversation(db, "a", "two");
    createConversation(db, "b", "other");
    const r = await conversationsDelete(req("/api/conversations", { method: "DELETE", body: "{}" }), ctx({}));
    expect(await r.json()).toEqual({ removed: 2 });
    expect(listConversations(db, "a")).toHaveLength(0);
    expect(listConversations(db, "b")).toHaveLength(1);
    expect(clearConversations(db, null)).toBe(1);
  });
});

describe("trimming the activity log", () => {
  function seed(db: ReturnType<typeof boot>) {
    addAudit(db, { kind: "tool_call", actor: "system", summary: "get_cml_labs ok" });
    addAudit(db, { kind: "tool_call", actor: "claude", summary: "show run ok" });
    addAudit(db, { kind: "approval", actor: "user", summary: "Approved a change" });
    db.prepare("INSERT INTO audit_events (at, kind, actor, summary) VALUES (?, 'configuration', 'user', 'An old deployment')").run(new Date(Date.now() - 200 * 86_400_000).toISOString());
  }

  it("drops background reads and nothing else", async () => {
    const db = boot();
    seed(db);
    const r = await activityDelete(req("/api/activity?mode=reads", { method: "DELETE", body: "{}" }), ctx({}));
    expect(await r.json()).toEqual({ removed: 1 });
    const left = listAudit(db).map((e) => e.summary);
    expect(left).toEqual(expect.arrayContaining(["show run ok", "Approved a change", "An old deployment"]));
    expect(left).not.toContain("get_cml_labs ok");
    expect(left[0]).toContain("Cleared 1 activity entry: background reads"); // the trim is itself on the record
  });

  it("drops entries older than the cut-off, and keeps recent ones", async () => {
    const db = boot();
    seed(db);
    const r = await activityDelete(req("/api/activity?mode=older&days=90", { method: "DELETE", body: "{}" }), ctx({}));
    expect(await r.json()).toEqual({ removed: 1 });
    const left = listAudit(db).map((e) => e.summary);
    expect(left).not.toContain("An old deployment");
    expect(left).toEqual(expect.arrayContaining(["get_cml_labs ok", "show run ok", "Approved a change"]));
  });

  it("has no way to wipe everything, and refuses a nonsense cut-off", async () => {
    const db = boot();
    seed(db);
    for (const url of ["/api/activity", "/api/activity?mode=all", "/api/activity?mode=older", "/api/activity?mode=older&days=1", "/api/activity?mode=older&days=0", "/api/activity?mode=older&days=99999"]) {
      expect((await activityDelete(req(url, { method: "DELETE", body: "{}" }), ctx({}))).status, url).toBe(400);
    }
    expect(listAudit(db)).toHaveLength(4);
  });

  it("reports how many reads are held back, so hiding them is never silent", async () => {
    const db = boot();
    seed(db);
    const hidden = await (await activityGet(req("/api/activity"), ctx({}))).json();
    expect(hidden.hiddenReads).toBe(1);
    expect(hidden.events.map((e: { summary: string }) => e.summary)).not.toContain("get_cml_labs ok");
    const shown = await (await activityGet(req("/api/activity?reads=1"), ctx({}))).json();
    expect(shown.hiddenReads).toBe(0);
    expect(shown.events.map((e: { summary: string }) => e.summary)).toContain("get_cml_labs ok");
  });
});
