import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acknowledgeDrift, listDrift, recordBackup } from "@/lib/backup/store";
import { approveChange, deployChange, proposeChange, resetChangeLocks } from "@/lib/changes/engine";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { BASELINE_MAX_DAYS, checkDevices, revokeSignOff, signOff } from "@/lib/readiness";
import { setContext } from "@/lib/server/context";
import { type StatefulDevice, startStatefulDevice } from "./helpers/fake-device";

const CFG = "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\ninterface GigabitEthernet0/1\n no ip address\n shutdown\n";
const SCOPE = "static:s";
let r1: StatefulDevice;
afterEach(() => { r1?.close(); setProviders(null); setContext(undefined); resetChangeLocks(); });

async function boot(env: "lab" | "production", settings: Record<string, unknown> = {}) {
  process.env.TS_TEST_PW = "secret";
  r1 = await startStatefulDevice({ host: "R1", config: CFG });
  const file = join(mkdtempSync(join(tmpdir(), "ts-ready-")), "inv.yaml");
  writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: ${env}\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${r1.port}, platform: ios, kind: router }\n`);
  const db = openDatabase(":memory:");
  saveSettings(db, { executionMode: "approve", ...settings });
  setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
  const provider = new StaticProvider(file);
  setProviders([provider]);
  return { db, provider };
}
const propose = () => proposeChange({ scopeId: SCOPE, title: "t", intent: "t", source: "user", devices: [{ device: "R1", commands: ["interface GigabitEthernet0/1", "description up", "no shutdown"] }] });
const ready = (db: ReturnType<typeof openDatabase>) => { recordBackup(db, { scopeId: SCOPE, device: "R1", config: CFG, source: "manual" }); signOff(db, SCOPE, "R1", "alex"); };
const failing = async (p: StaticProvider, db: ReturnType<typeof openDatabase>, now?: Date) => {
  const topo = await p.getTopology(SCOPE);
  return checkDevices(db, SCOPE, topo.nodes, p, p.transport(SCOPE), now)[0].checks.filter((c) => !c.ok).map((c) => c.id);
};

describe("the go-live gate", () => {
  it("refuses a production change to a device that has no backup and no sign-off, and says why", async () => {
    await boot("production");
    await expect(propose()).rejects.toThrow(/1 device is not ready to go live: R1 \(No configuration has been backed up yet/);
  });

  it("lists every failing check for a device", async () => {
    const { db, provider } = await boot("production");
    expect(await failing(provider, db)).toEqual(["baseline", "signoff"]);
  });

  it("lets the change through once the device has a recent backup and a person has signed it off", async () => {
    const { db } = await boot("production");
    ready(db);
    expect((await propose()).status).toBe("proposed");
  });

  it("does not take a sign-off alone: the backup is what rollback depends on", async () => {
    const { db, provider } = await boot("production");
    signOff(db, SCOPE, "R1", "alex");
    expect(await failing(provider, db)).toEqual(["baseline"]);
  });

  it("stops trusting a backup older than the limit", async () => {
    const { db, provider } = await boot("production");
    ready(db);
    const later = new Date(Date.now() + (BASELINE_MAX_DAYS + 1) * 86_400_000);
    expect(await failing(provider, db, later)).toEqual(["baseline"]);
    expect(await failing(provider, db, new Date(Date.now() + (BASELINE_MAX_DAYS - 1) * 86_400_000))).toEqual([]);
  });

  it("holds a device that someone changed directly until the difference is acknowledged", async () => {
    const { db, provider } = await boot("production");
    ready(db);
    recordBackup(db, { scopeId: SCOPE, device: "R1", config: CFG + "ip route 0.0.0.0 0.0.0.0 10.0.0.9\n", source: "scheduled" });
    expect(await failing(provider, db)).toEqual(["drift"]);
    await expect(propose()).rejects.toThrow(/unreviewed difference/);
    for (const d of listDrift(db, SCOPE)) acknowledgeDrift(db, d.id, "alex");
    expect(await failing(provider, db)).toEqual([]);
  });

  it("does not apply a change when a device stopped being ready after it was proposed", async () => {
    const { db } = await boot("production");
    ready(db);
    const c = await propose();
    approveChange(c.id, "sam");
    expect(revokeSignOff(db, SCOPE, "R1")).toBe(true);
    const done = await deployChange(c.id);
    expect(done.status).toBe("failed");
    expect(done.result?.summary).toMatch(/Refused to apply: 1 device is not ready to go live.*Nothing was changed/);
    expect(done.result?.devices[0].steps.join(" ")).toMatch(/Not ready to go live/);
    expect(r1.config).toEqual([]);
  });

  it("never holds a lab to it", async () => {
    await boot("lab");
    expect((await propose()).status).toBe("proposed");
  });

  it("can be switched off", async () => {
    await boot("production", { requireDeviceReadiness: false });
    expect((await propose()).status).toBe("proposed");
  });

  it("is on unless someone turns it off", async () => {
    const { db } = await boot("production");
    const row = db.prepare("SELECT value FROM settings WHERE key = 'requireDeviceReadiness'").get();
    expect(row).toBeUndefined();
    await expect(propose()).rejects.toThrow(/not ready to go live/);
  });
});
