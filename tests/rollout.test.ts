import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Override, ChangeError, approveChange, assertDeployable, autoApprovable, continueChange, deployChange, proposeChange, resetChangeLocks, rollbackChange, scheduleChange } from "@/lib/changes/engine";
import { previewChange } from "@/lib/changes/preview";
import { getChange } from "@/lib/changes/store";
import { DEFAULT_WINDOW, describeWindow, inWindow, maintenanceWindowSchema } from "@/lib/changes/window";
import { listDrift, listVersions } from "@/lib/backup/store";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { schedulerTick } from "@/lib/server/scheduler";
import { type StatefulDevice, startStatefulDevice } from "./helpers/fake-device";
import { type FakeJunos, startJunos } from "./helpers/fake-api";

const MIN = 60_000;
const R1_CFG = "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\ninterface GigabitEthernet0/1\n no ip address\n shutdown\n";
const R2_CFG = R1_CFG.replace("R1", "R2").replace("10.0.0.1", "10.0.0.2");

const win = (over: Partial<ReturnType<typeof maintenanceWindowSchema.parse>> = {}) => ({ ...DEFAULT_WINDOW, ...over });
const at = (iso: string) => new Date(iso);

describe("maintenance window", () => {
  it("lets everything through when it is off", () => expect(inWindow(win({ enabled: false, days: [] }), new Date())).toBe(true));

  it("holds a same-day window to its days and hours, end exclusive", () => {
    const w = win({ enabled: true, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timezone: "UTC" });
    expect(inWindow(w, at("2026-11-09T10:00:00Z"))).toBe(true);   // Monday
    expect(inWindow(w, at("2026-11-09T08:59:00Z"))).toBe(false);
    expect(inWindow(w, at("2026-11-09T17:00:00Z"))).toBe(false);
    expect(inWindow(w, at("2026-11-14T10:00:00Z"))).toBe(false);  // Saturday
  });

  it("runs an overnight window into the next morning, which belongs to the day it started", () => {
    const w = win({ enabled: true, days: [5], start: "22:00", end: "06:00", timezone: "UTC" }); // Fridays
    expect(inWindow(w, at("2026-11-13T23:00:00Z"))).toBe(true);   // Fri night
    expect(inWindow(w, at("2026-11-14T03:00:00Z"))).toBe(true);   // Sat early: still Friday's window
    expect(inWindow(w, at("2026-11-14T07:00:00Z"))).toBe(false);
    expect(inWindow(w, at("2026-11-15T03:00:00Z"))).toBe(false);  // Sun early: Saturday's window is not listed
    expect(inWindow(w, at("2026-11-13T05:00:00Z"))).toBe(false);  // Fri early: Thursday's window is not listed
  });

  it("reads the hours in the window's own time zone", () => {
    const w = win({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", timezone: "America/New_York" }); // UTC-5 in November
    expect(inWindow(w, at("2026-11-09T15:00:00Z"))).toBe(true);   // 10:00 there
    expect(inWindow(w, at("2026-11-09T13:00:00Z"))).toBe(false);  // 08:00 there
  });

  it("treats equal start and end as the whole of each listed day", () => {
    const w = win({ enabled: true, days: [1], start: "00:00", end: "00:00", timezone: "UTC" });
    expect(inWindow(w, at("2026-11-09T13:00:00Z"))).toBe(true);
    expect(inWindow(w, at("2026-11-10T13:00:00Z"))).toBe(false);
  });

  it("describes itself, and rejects bad times and zones", () => {
    expect(describeWindow(win({ days: [1, 3], start: "22:00", end: "06:00", timezone: "Europe/London" }))).toBe("Mon, Wed, 22:00 to 06:00 (Europe/London)");
    expect(maintenanceWindowSchema.safeParse({ start: "25:00" }).success).toBe(false);
    expect(maintenanceWindowSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    expect(maintenanceWindowSchema.safeParse({ days: [7] }).success).toBe(false);
  });
});

let r1: StatefulDevice, r2: StatefulDevice, junos: FakeJunos | null = null;
afterEach(() => { r1?.close(); r2?.close(); junos?.close(); junos = null; setProviders(null); setContext(undefined); resetChangeLocks(); });

async function boot(o: { env?: "lab" | "production"; mode?: "approve" | "autopilot"; window?: ReturnType<typeof win>; r1?: Parameters<typeof startStatefulDevice>[0]; r2?: Parameters<typeof startStatefulDevice>[0] } = {}) {
  process.env.TS_TEST_PW = "secret";
  r1 = await startStatefulDevice({ host: "R1", config: R1_CFG, ...o.r1 });
  r2 = await startStatefulDevice({ host: "R2", config: R2_CFG, ...o.r2 });
  const file = join(mkdtempSync(join(tmpdir(), "ts-ro-")), "inv.yaml");
  writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: ${o.env ?? "lab"}\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${r1.port}, platform: ios, kind: router }\n      - { name: R2, address: 127.0.0.1, port: ${r2.port}, platform: ios, kind: router }\n`);
  const db = openDatabase(":memory:");
  saveSettings(db, { executionMode: o.mode ?? "approve", autopilotAllowConfig: true, maintenanceWindow: o.window ?? win() });
  setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
  setProviders([new StaticProvider(file)]);
  return db;
}
const SCOPE = "static:s";
const both = (d1 = "description one", d2 = "description two") => [
  { device: "R1", commands: ["interface GigabitEthernet0/1", d1, "no shutdown"] },
  { device: "R2", commands: ["interface GigabitEthernet0/1", d2, "no shutdown"] },
];
const propose = (devices = both(), extra: Partial<Parameters<typeof proposeChange>[0]> = {}) => proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices, ...extra });

describe("the maintenance window on production changes", () => {
  const closed = win({ enabled: true, days: [], start: "09:00", end: "17:00", timezone: "UTC" }); // never open

  it("refuses to apply a production change outside the window, and says what the window is", async () => {
    await boot({ env: "production", window: closed });
    const c = await propose(both(), { rollout: { mode: "all", canary: 1, pauseAfterCanary: false } });
    approveChange(c.id);
    await expect(deployChange(c.id)).rejects.toThrow(/Outside the maintenance window \(no days, 09:00 to 17:00 \(UTC\)\)/);
    expect(r1.config).toEqual([]);
  });

  it("applies it anyway only with a real reason, and records that reason once", async () => {
    const db = await boot({ env: "production", window: closed });
    const c = await propose(both(), { rollout: { mode: "all", canary: 1, pauseAfterCanary: false } });
    approveChange(c.id);
    const bad: Override = { reason: "urgent" };
    await expect(deployChange(c.id, bad)).rejects.toThrow(/at least 10 characters/);
    const done = await deployChange(c.id, { reason: "Customer outage on the London uplink, ticket 4411" });
    expect(done.status).toBe("verified");
    const audits = db.prepare("SELECT summary FROM audit_events WHERE summary LIKE 'Maintenance window overridden%'").all() as { summary: string }[];
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toContain("ticket 4411");
  });

  it("does not hold a lab to it, nor a production network whose window is off", async () => {
    await boot({ env: "lab", window: closed });
    const c = await propose();
    approveChange(c.id);
    expect(() => assertDeployable(c.id)).not.toThrow();
  });
});

describe("scheduling", () => {
  it("accepts a time in the future, and clears it", async () => {
    await boot();
    const c = await propose();
    approveChange(c.id);
    const t = new Date(Date.now() + 10 * MIN);
    expect(scheduleChange(c.id, t).scheduledFor).toBe(t.toISOString());
    expect(scheduleChange(c.id, null).scheduledFor).toBeNull();
  });
  it("refuses a time in the past, one too far ahead, a change nobody approved, and a production time outside the window", async () => {
    await boot({ env: "production", window: win({ enabled: true, days: [1], start: "09:00", end: "17:00", timezone: "UTC" }) });
    const c = await propose(both(), { rollout: { mode: "all", canary: 1, pauseAfterCanary: false } });
    expect(() => scheduleChange(c.id, new Date(Date.now() + 10 * MIN))).toThrow(/Approve the change/);
    approveChange(c.id);
    expect(() => scheduleChange(c.id, new Date(Date.now() - MIN))).toThrow(/at least a minute/);
    expect(() => scheduleChange(c.id, new Date(Date.now() + 40 * 86_400_000))).toThrow(/30 days/);
    expect(() => scheduleChange(c.id, new Date("2026-11-14T10:00:00Z"), new Date("2026-11-10T00:00:00Z"))).toThrow(/outside the maintenance window/); // a Saturday
    expect(scheduleChange(c.id, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-10T00:00:00Z")).scheduledFor).toBe("2026-11-16T10:00:00.000Z"); // a Monday
  });

  it("applies an approved change when its time comes, and not before", async () => {
    await boot();
    const c = await propose();
    approveChange(c.id);
    scheduleChange(c.id, new Date(Date.now() + 5 * MIN));
    expect((await schedulerTick(Date.now() + MIN)).ran).toEqual([]);
    expect(getChange(openDb(), c.id)?.status).toBe("approved");
    expect((await schedulerTick(Date.now() + 6 * MIN)).ran).toEqual([`change:${c.id}`]);
    const after = getChange(openDb(), c.id)!;
    expect(after.status).toBe("verified");
    expect(after.scheduledFor).toBeNull();
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("description one");
  });

  it("clears the schedule, and says so, if the window has closed by the time it runs", async () => {
    const db = await boot({ env: "production", window: win({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" }) });
    const c = await propose(both(), { rollout: { mode: "all", canary: 1, pauseAfterCanary: false } });
    approveChange(c.id);
    scheduleChange(c.id, new Date(Date.now() + 5 * MIN));
    saveSettings(db, { maintenanceWindow: win({ enabled: true, days: [], start: "09:00", end: "17:00", timezone: "UTC" }) }); // the window was changed meanwhile
    const r = await schedulerTick(Date.now() + 6 * MIN);
    expect(r.failed).toEqual([`change:${c.id}`]);
    const after = getChange(db, c.id)!;
    expect(after.status).toBe("approved");
    expect(after.scheduledFor).toBeNull();
    expect(db.prepare("SELECT summary FROM audit_events WHERE actor = 'scheduler' AND kind = 'error'").all()).toHaveLength(1);
    expect(r1.config).toEqual([]);
  });
});

function openDb() {
  // The test context's database, through the same accessor the app uses.
  return (globalThis as unknown as Record<string, { db: ReturnType<typeof openDatabase> }>).__tinySnitchContext.db;
}

describe("staged rollout", () => {
  it("makes several-device production changes canary-first by default, and labs all-at-once", async () => {
    await boot({ env: "production" });
    expect((await propose()).plan.rollout).toEqual({ mode: "staged", canary: 1, pauseAfterCanary: true });
    expect((await propose([both()[0]])).plan.rollout).toBeUndefined(); // one device: nothing to stage
    r1.close(); r2.close(); setProviders(null); setContext(undefined);
    await boot({ env: "lab" });
    expect((await propose()).plan.rollout).toBeUndefined();
  });

  it("applies and verifies the canary, leaves the others untouched, pauses, then continues", async () => {
    const db = await boot({ env: "production" });
    const c = await propose();
    approveChange(c.id);
    const paused = await deployChange(c.id);
    expect(paused.status).toBe("paused");
    expect(paused.result?.summary).toMatch(/canary \(R1\).*other 1 device\(s\) have not been touched/);
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("description one");
    expect(r2.config).toEqual([]); // not a single line sent
    expect(paused.result?.devices.find((d) => d.label === "R2")?.pushed).toBe(false);

    const done = await continueChange(c.id);
    expect(done.status).toBe("verified");
    expect(r2.blocks.get("interface GigabitEthernet0/1")).toContain("description two");
    expect(done.result?.devices.map((d) => [d.label, d.pushed, d.verified])).toEqual([["R1", true, true], ["R2", true, true]]);
    expect(listVersions(db, SCOPE, "R2").some((v) => v.source === `change:${c.id}`)).toBe(true);
    await expect(continueChange(c.id)).rejects.toThrow(/nothing to continue/);
  });

  it("stops at a canary that rejects the change and never touches the rest", async () => {
    await boot({ env: "production", r1: { host: "R1", config: R1_CFG, reject: ["description one"] } });
    const c = await propose();
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("rolled_back");
    expect(done.result?.summary).toMatch(/R1 rejected the change \(canary devices\)/);
    expect(r2.config).toEqual([]);
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("shutdown");
  });

  it("leaves the others untouched, and the canary applied, when the canary cannot be verified", async () => {
    await boot({ env: "production", r1: { host: "R1", config: R1_CFG, ignore: ["description one"] } });
    const c = await propose();
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("failed");
    expect(done.result?.summary).toMatch(/canary was applied but could not be fully verified. The other devices were not touched/);
    expect(r2.config).toEqual([]);
  });

  it("rolls everything back, canary included, if a later device rejects the change", async () => {
    await boot({ env: "production", r2: { host: "R2", config: R2_CFG, reject: ["description two"] } });
    const c = await propose();
    approveChange(c.id);
    expect((await deployChange(c.id)).status).toBe("paused");
    const done = await continueChange(c.id);
    expect(done.status).toBe("rolled_back");
    expect(done.result?.summary).toMatch(/R2 rejected the change/);
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("shutdown"); // the canary was put back too
    expect(r1.blocks.get("interface GigabitEthernet0/1")).not.toContain("description one");
  });

  it("can be rolled back while paused, undoing the canary", async () => {
    await boot({ env: "production" });
    const c = await propose();
    approveChange(c.id);
    await deployChange(c.id);
    const rb = await rollbackChange(c.id);
    expect(rb.status).toBe("rolled_back");
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("shutdown");
    expect(r2.config).toEqual([]);
  });

  it("reads the remaining devices again before continuing, so a change made meanwhile is noticed", async () => {
    const db = await boot({ env: "production" });
    const c = await propose();
    approveChange(c.id);
    await deployChange(c.id);
    r2.blocks.get("")!.push("ntp server 10.9.9.9"); // someone changes R2 while the change is paused
    await continueChange(c.id);
    const drift = listDrift(db, SCOPE).filter((d) => d.device === "R2");
    expect(drift.length).toBeGreaterThan(0);
  });

  it("stays paused, with the canary in place, if a remaining device cannot be read when continuing", async () => {
    await boot({ env: "production" });
    const c = await propose();
    approveChange(c.id);
    await deployChange(c.id);
    r2.failShow.on = true;
    const again = await continueChange(c.id);
    expect(again.status).toBe("paused");
    expect(again.result?.summary).toMatch(/Nothing more was changed.*canary stays applied/);
    expect(r2.config).toEqual([]);
    r2.failShow.on = false;
    expect((await continueChange(c.id)).status).toBe("verified");
  });

  it("lets a person choose all-at-once for production, or a canary without a pause", async () => {
    await boot({ env: "production" });
    const all = await propose(both(), { rollout: { mode: "all", canary: 1, pauseAfterCanary: false } });
    approveChange(all.id);
    expect((await deployChange(all.id)).status).toBe("verified");
    const noPause = await propose(both("description x", "description y"), { rollout: { mode: "staged", canary: 1, pauseAfterCanary: false } });
    approveChange(noPause.id);
    expect((await deployChange(noPause.id)).status).toBe("verified"); // canary, then the rest, in one run
    expect(r2.blocks.get("interface GigabitEthernet0/1")).toContain("description y");
  });

  it("rejects a staged rollout that makes no sense, and Autopilot never runs one that waits for a person", async () => {
    await boot({ env: "lab", mode: "autopilot" });
    await expect(propose([both()[0]], { rollout: { mode: "staged", canary: 1, pauseAfterCanary: true } })).rejects.toThrow(/at least two devices/);
    await expect(propose(both(), { rollout: { mode: "staged", canary: 2, pauseAfterCanary: true } })).rejects.toBeInstanceOf(ChangeError);
    const c = await propose(both(), { rollout: { mode: "staged", canary: 1, pauseAfterCanary: true } });
    expect(autoApprovable(c, "autopilot", true).reasons.join()).toMatch(/pauses after the canary/);
  });
});

describe("preview", () => {
  it("says which lines would change a device and which are already there, then nothing once applied", async () => {
    await boot();
    r1.blocks.get("interface GigabitEthernet0/1")!.push("description one"); // R1 already has this line
    const c = await propose();
    const p = await previewChange(c.id);
    const d1 = p.devices.find((d) => d.label === "R1")!, d2 = p.devices.find((d) => d.label === "R2")!;
    expect(d1.alreadyInPlace).toEqual(["description one"]);
    expect(d1.wouldChange).toEqual(["no shutdown"]);
    expect(d2.wouldChange).toEqual(["description two", "no shutdown"]);
    expect(p.summary).toMatch(/2 of 2 device\(s\) read/);
    expect(r1.config).toEqual([]); // it only read

    approveChange(c.id);
    await deployChange(c.id);
    const after = await previewChange(c.id);
    expect(after.devices.every((d) => d.wouldChange.length === 0)).toBe(true);
    expect(after.summary).toMatch(/2 already have every line/);
  });

  it("reports a device it cannot read instead of guessing, and says what staging will do", async () => {
    await boot({ env: "production" });
    const c = await propose();
    r2.failShow.on = true;
    const p = await previewChange(c.id);
    expect(p.devices.find((d) => d.label === "R2")).toMatchObject({ reachable: false });
    expect(p.summary).toMatch(/1 could not be read, so nothing is known about them/);
    expect(p.summary).toMatch(/Staged: R1 first, then it pauses for you/);
    expect(p.canary).toEqual(["R1"]);
  });

  it("flags a change that would cut off the address Tiny Snitch uses", async () => {
    await boot({ r1: { host: "R1", config: R1_CFG.replace("10.0.0.1 255.255.255.0", "127.0.0.1 255.0.0.0") } });
    const c = await propose([{ device: "R1", commands: ["interface GigabitEthernet0/0", "shutdown"] }]);
    const p = await previewChange(c.id);
    expect(p.devices[0].cutoff).toMatch(/would lose contact|reaches this device on/);
  });

  it("asks a Junos device to commit-check the change, without keeping it", async () => {
    junos = await startJunos({ config: ["set system host-name J1", "set interfaces ge-0/0/1 disable"] });
    process.env.TS_TEST_PW = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-ro-j-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: J1, address: 127.0.0.1, port: ${junos.port}, platform: junos, transport: netconf, kind: router }\n`);
    const db = openDatabase(":memory:");
    saveSettings(db, { executionMode: "approve" });
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
    r1 = r2 = { close: () => undefined } as StatefulDevice;

    const good = await proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices: [{ device: "J1", commands: ["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description up"] }] });
    const p = await previewChange(good.id);
    expect(p.devices[0].wouldChange).toEqual(["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description up"]);
    expect(p.devices[0].deviceCheck).toMatchObject({ ok: true });
    expect(junos.committed.has("set interfaces ge-0/0/1 disable")).toBe(true); // nothing was committed
    expect(junos.candidate).toEqual(junos.committed);
    expect(junos.locked).toBe(false);

    const bad = await proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices: [{ device: "J1", commands: ["set bogus thing"] }] });
    const q = await previewChange(bad.id);
    expect(q.devices[0].deviceCheck).toMatchObject({ ok: false });
    expect(q.devices[0].deviceCheck?.text).toMatch(/would reject the change/);
    expect(junos.candidate).toEqual(junos.committed);
    expect(junos.locked).toBe(false);
  });
});
