import { describe, expect, it } from "vitest";
import { openDatabase, resolveDatabasePath } from "../lib/database/db";
import { addAudit, getSettings, listAudit, saveSettings } from "../lib/database/repo";
import { redactSecrets } from "../lib/security/redact";
import { DEFAULT_SETTINGS, settingsPatchSchema } from "../lib/settings";

describe("database", () => {
  it("creates the schema and is safe to open twice", () => {
    const db = openDatabase(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["settings", "conversations", "messages", "deployments", "findings", "audit_events", "node_positions"]));
  });
  it("resolves DATABASE_URL forms", () => {
    expect(resolveDatabasePath("file::memory:")).toBe(":memory:");
    expect(resolveDatabasePath("file:./data/x.db", "/app")).toMatch(/app[\\/]data[\\/]x\.db$/);
    expect(() => resolveDatabasePath("postgres://x")).toThrow(/file:/);
  });
});

describe("settings", () => {
  it("returns safe defaults and persists patches", () => {
    const db = openDatabase(":memory:");
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.executionMode).toBe("approve");
    expect(DEFAULT_SETTINGS.autopilotAllowConfig).toBe(false);
    const saved = saveSettings(db, { executionMode: "suggest", selectedLabId: "abc", selectedLabTitle: "Lab" });
    expect(saved).toMatchObject({ executionMode: "suggest", selectedLabId: "abc", snapshotBeforeChange: true });
    expect(getSettings(db).executionMode).toBe("suggest");
  });
  it("rejects unknown keys and bad values in a patch", () => {
    expect(settingsPatchSchema.safeParse({ executionMode: "yolo" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ apiKey: "x" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ snapshotBeforeChange: false }).success).toBe(true);
  });
  it("falls back to defaults when a stored value is corrupt", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO settings VALUES ('executionMode', 'not json', 'now')").run();
    expect(getSettings(db).executionMode).toBe("approve");
  });
});

describe("audit log", () => {
  it("records newest first", () => {
    const db = openDatabase(":memory:");
    addAudit(db, { kind: "mcp", summary: "connected" });
    addAudit(db, { kind: "tool_call", summary: "get_cml_labs ok", actor: "claude", data: { ms: 38 } });
    const [a, b] = listAudit(db);
    expect(a).toMatchObject({ kind: "tool_call", actor: "claude", data: { ms: 38 } });
    expect(b.summary).toBe("connected");
  });
  it("never stores credentials", () => {
    const db = openDatabase(":memory:");
    addAudit(db, { kind: "error", summary: "failed with Authorization: Basic YWRtaW46aHVudGVyMg==", data: { password: "hunter2", note: "enable secret 9 abcdef" } });
    const [e] = listAudit(db);
    const blob = JSON.stringify(e);
    expect(blob).not.toContain("YWRtaW46aHVudGVyMg");
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("abcdef");
  });
});

describe("redactSecrets", () => {
  it.each([
    ["Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["Bearer abcdefghijkl.mnop", "abcdefghijkl"],
    ["key sk-ant-api03-ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOP"],
    ['{"password":"p4ss"}', "p4ss"],
    ["snmp-server community s3cret RO", "s3cret"],
    ["username bob privilege 15 secret 9 $9$zz", "$9$zz"],
  ])("masks %s", (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
  });
  it("leaves ordinary text alone", () => {
    expect(redactSecrets("get_cml_labs ok in 38 ms")).toBe("get_cml_labs ok in 38 ms");
  });
});
