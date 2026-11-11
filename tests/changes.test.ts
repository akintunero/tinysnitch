import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectations, parseBlocks, remainingDifferences, rollbackCommands, touchedScope, verifyApplied } from "@/lib/changes/config-diff";
import { ChangeError, acquireNetworkLock, approveChange, autoApprovable, deployChange, isNetworkBusy, managementCutoff, proposeAndMaybeApply, proposeChange, rejectChange, resetChangeLocks, rollbackChange, saveChange } from "@/lib/changes/engine";
import { getChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { type StatefulDevice, startStatefulDevice } from "./helpers/fake-device";

const R1_CFG = `hostname R1
!
interface GigabitEthernet0/0
 description to R2
 ip address 10.0.0.1 255.255.255.0
!
interface GigabitEthernet0/1
 no ip address
 shutdown
!
router ospf 1
 router-id 1.1.1.1
!`;
const R2_CFG = R1_CFG.replace("hostname R1", "hostname R2").replace("10.0.0.1", "10.0.0.2").replace("1.1.1.1", "2.2.2.2");

describe("config blocks, verification and rollback (no devices involved)", () => {
  it("reads blocks and ignores the lines that change on their own", () => {
    const b = parseBlocks(`Building configuration...\n\nCurrent configuration : 3017 bytes\n!\n! Last configuration change at 08:48:07 UTC\n!\nhostname R1\n!\ninterface GigabitEthernet0/1\n no ip address\n shutdown\n!\nip route 0.0.0.0 0.0.0.0 10.0.0.9\n!\nbanner exec ^C\nhello\n^C\nend`);
    expect([...b.keys()]).toEqual(["", "interface GigabitEthernet0/1"]);
    expect(b.get("")).toEqual(["hostname R1", "ip route 0.0.0.0 0.0.0.0 10.0.0.9"]);
    expect(b.get("interface GigabitEthernet0/1")).toEqual(["no ip address", "shutdown"]);
  });

  it("treats Gi0/1 and GigabitEthernet0/1 as one interface", () => {
    const v = verifyApplied(["interface Gi0/1", "description x"], "interface GigabitEthernet0/1\n description x\n!");
    expect(v.ok).toBe(true);
  });

  it("verifies presence and absence, and names what did not take effect", () => {
    const after = "interface GigabitEthernet0/1\n description new\n ip address 10.0.1.1 255.255.255.0\n!\n";
    expect(verifyApplied(["interface Gi0/1", "description new", "ip address 10.0.1.1 255.255.255.0", "no shutdown"], after).ok).toBe(true);
    const bad = verifyApplied(["interface Gi0/1", "shutdown", "no description"], after);
    expect(bad.ok).toBe(false);
    expect(bad.mismatches.map((m) => m.command)).toEqual(["shutdown", "no description"]);
    expect(verifyApplied(["router ospf 5"], after).mismatches[0].expected).toMatch(/router ospf 5/);
    expect(verifyApplied(["no interface Loopback9"], after).ok).toBe(true);
  });

  it("computes the commands that undo a change: replaces single values, removes additions, restores deletions", () => {
    const snap = "hostname R1\ninterface GigabitEthernet0/1\n description old\n shutdown\n!\nrouter ospf 1\n router-id 1.1.1.1\n network 10.0.0.0 0.0.0.255 area 0\n!";
    const now = "hostname R1\ninterface GigabitEthernet0/1\n description new\n ip address 10.0.1.1 255.255.255.0\n!\nrouter ospf 1\n router-id 1.1.1.1\n!\ninterface Loopback5\n ip address 5.5.5.5 255.255.255.255\n!";
    const plan = ["interface Gi0/1", "description new", "ip address 10.0.1.1 255.255.255.0", "no shutdown", "router ospf 1", "no network 10.0.0.0 0.0.0.255 area 0", "interface Loopback5", "ip address 5.5.5.5 255.255.255.255"];
    const rb = rollbackCommands(snap, now, touchedScope(plan));
    expect(rb.commands).toEqual(expect.arrayContaining(["interface GigabitEthernet0/1", "description old", "no ip address 10.0.1.1 255.255.255.0", "shutdown", "router ospf 1", "network 10.0.0.0 0.0.0.255 area 0", "no interface Loopback5"]));
    expect(rb.commands).not.toContain("no description new"); // replaced by the old value, not negated
    expect(expectations(["interface Gi0/1", "no shutdown"])[1]).toMatchObject({ block: "interface GigabitEthernet0/1", kind: "absent" });
  });

  it("leaves other people's changes alone: rollback is limited to what the change touched", () => {
    const snap = "interface GigabitEthernet0/1\n description old\n!\ninterface GigabitEthernet0/2\n description keep\n!";
    const now = "interface GigabitEthernet0/1\n description new\n!\ninterface GigabitEthernet0/2\n description someone-else-changed-this\n!";
    const rb = rollbackCommands(snap, now, touchedScope(["interface Gi0/1", "description new"]));
    expect(rb.commands.join("\n")).toContain("description old");
    expect(rb.commands.join("\n")).not.toContain("GigabitEthernet0/2");
    expect(remainingDifferences(snap, now)).toEqual(["interface GigabitEthernet0/1", "interface GigabitEthernet0/2"]);
  });

  it("recognises commands that would cut off the management address", () => {
    const cfg = "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.9.9.9 255.255.255.0\n!\ninterface GigabitEthernet0/1\n ip address 10.0.0.1 255.255.255.0\n!";
    expect(managementCutoff(cfg, "ios", "10.9.9.9", ["interface Gi0/0", "shutdown"])).toMatch(/shutdown.*10\.9\.9\.9/);
    expect(managementCutoff(cfg, "ios", "10.9.9.9", ["interface Gi0/0", "no ip address"])).toMatch(/removing the address/);
    expect(managementCutoff(cfg, "ios", "10.9.9.9", ["interface Gi0/1", "shutdown"])).toBeNull();
    expect(managementCutoff(cfg, "ios", undefined, ["interface Gi0/0", "shutdown"])).toBeNull();
  });
});

describe("the change workflow against devices that hold real configuration", () => {
  let r1: StatefulDevice, r2: StatefulDevice, env: "lab" | "production";
  const SCOPE = "static:site";

  async function boot(over: { env?: "lab" | "production"; mode?: "suggest" | "approve" | "autopilot"; r1?: Parameters<typeof startStatefulDevice>[0]; r2?: Parameters<typeof startStatefulDevice>[0] } = {}) {
    process.env.TS_TEST_PW = "secret";
    env = over.env ?? "lab";
    r1 = await startStatefulDevice({ host: "R1", config: R1_CFG, ...over.r1 });
    r2 = await startStatefulDevice({ host: "R2", config: R2_CFG, ...over.r2 });
    const file = join(mkdtempSync(join(tmpdir(), "ts-chg-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: site\n    title: Site\n    environment: ${env}\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${r1.port}, platform: ios }\n      - { name: R2, address: 127.0.0.1, port: ${r2.port}, platform: ios }\n    links:\n      - { a: R1, aInterface: Gi0/0, b: R2, bInterface: Gi0/0 }\n`);
    const db = openDatabase(":memory:");
    saveSettings(db, { executionMode: over.mode ?? "approve", autopilotAllowConfig: true });
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
    return db;
  }
  beforeEach(() => undefined);
  afterEach(() => { r1?.close(); r2?.close(); setProviders(null); setContext(undefined); resetChangeLocks(); });

  const both = [
    { device: "R1", commands: ["interface GigabitEthernet0/1", "description uplink", "ip address 10.0.1.1 255.255.255.0", "no shutdown"] },
    { device: "R2", commands: ["interface GigabitEthernet0/1", "description uplink", "ip address 10.0.1.2 255.255.255.0", "no shutdown"] },
  ];
  const propose = (devices = both, title = "Bring up the uplink") => proposeChange({ scopeId: SCOPE, title, intent: "bring up the second link", source: "user", devices });

  it("proposes, needs approval, deploys, verifies against the device, and records the snapshot", async () => {
    const db = await boot();
    const c = await propose();
    expect(c).toMatchObject({ status: "proposed", environment: "lab" });
    await expect(deployChange(c.id)).rejects.toThrow(/not been approved/);
    expect(r1.sent).not.toContain("configure terminal"); // a proposal touches nothing
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("verified");
    expect(done.result?.devices.map((d) => [d.label, d.pushed, d.verified])).toEqual([["R1", true, true], ["R2", true, true]]);
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toEqual(expect.arrayContaining(["description uplink", "ip address 10.0.1.1 255.255.255.0"]));
    expect(r1.blocks.get("interface GigabitEthernet0/1")).not.toContain("shutdown");
    expect(getChange(db, c.id)?.snapshot?.R1).toContain("hostname R1");
    expect(done.result?.saved).toBe(false); // nothing is written to startup unless someone chooses to
    expect(r1.sent).not.toContain("write memory");
    const saved = await saveChange(c.id);
    expect(saved.result?.saved).toBe(true);
    expect(r1.sent).toContain("write memory");
  });

  it("rolls the change back to the snapshot and confirms it against the device", async () => {
    await boot();
    const before1 = r1.text();
    const c = await propose();
    approveChange(c.id);
    await deployChange(c.id);
    const rb = await rollbackChange(c.id);
    expect(rb.status).toBe("rolled_back");
    expect(rb.result?.devices.every((d) => d.rolledBack)).toBe(true);
    expect(remainingDifferences(before1, r1.text())).toEqual([]);
    expect(remainingDifferences(R2_CFG, r2.text())).toEqual([]);
  });

  it("undoes the whole change everywhere when one device rejects a line", async () => {
    await boot({ r2: { host: "R2", config: R2_CFG, reject: ["ip address 10.0.1.2 255.255.255.0"] } });
    const before1 = r1.text();
    const c = await propose();
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("rolled_back");
    expect(done.result?.summary).toMatch(/R2 rejected the change/);
    expect(done.result?.devices.find((d) => d.label === "R2")?.steps.join(" ")).toMatch(/Rejected at "ip address 10\.0\.1\.2/);
    expect(remainingDifferences(before1, r1.text())).toEqual([]); // R1 had accepted everything and was put back
    expect(r1.blocks.get("interface GigabitEthernet0/1")).toContain("shutdown");
  });

  it("changes nothing when a device cannot be read first", async () => {
    await boot();
    const c = await propose();
    approveChange(c.id);
    r2.failShow.on = true;
    const done = await deployChange(c.id);
    expect(done.status).toBe("failed");
    expect(done.result?.summary).toMatch(/Could not take a snapshot of R2.*Nothing was changed/);
    expect(r1.config).toEqual([]);
    expect(r2.config).toEqual([]);
  });

  it("refuses a change that would cut off the address it manages the device on", async () => {
    await boot({ r1: { host: "R1", config: R1_CFG.replace("10.0.0.1 255.255.255.0", "127.0.0.1 255.0.0.0") } });
    const c = await propose([{ device: "R1", commands: ["interface GigabitEthernet0/0", "shutdown"] }]);
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("failed");
    expect(done.result?.summary).toMatch(/would lose contact with Tiny Snitch/);
    expect(r1.config).toEqual([]);
  });

  it("reports a line the device accepted but did not apply, instead of calling it done", async () => {
    await boot({ r1: { host: "R1", config: R1_CFG, ignore: ["description uplink"] } });
    const c = await propose();
    approveChange(c.id);
    const done = await deployChange(c.id);
    expect(done.status).toBe("failed");
    expect(done.result?.devices[0].verified).toBe(false);
    expect(done.result?.devices[0].mismatches[0].command).toBe("description uplink");
    expect(done.result?.summary).toMatch(/could not be fully verified/);
  });

  it("never proposes commands that destroy state", async () => {
    await boot();
    await expect(propose([{ device: "R1", commands: ["interface Gi0/1", "reload"] }])).rejects.toThrow(/reloads the device/);
    await expect(propose([{ device: "R1", commands: ["write erase"] }])).rejects.toBeInstanceOf(ChangeError);
    await expect(propose([{ device: "R9", commands: ["description x"] }])).rejects.toThrow(/no device named "R9"/);
    await expect(propose([])).rejects.toThrow(/at least one device/);
  });

  it("strips configure terminal and end, which Tiny Snitch supplies itself, and says so", async () => {
    await boot();
    const c = await propose([{ device: "R1", commands: ["configure terminal", "interface Gi0/1", "description x", "end", "! a comment"] }]);
    expect(c.plan.devices[0].commands).toEqual(["interface Gi0/1", "description x"]);
    expect(c.plan.warnings.join()).toMatch(/ignored 3 line/);
  });

  it("Suggest mode drafts only: it cannot be approved or deployed", async () => {
    await boot({ mode: "suggest" });
    const c = await propose();
    expect(() => approveChange(c.id)).toThrow(/Suggest mode/);
    expect(rejectChange(c.id).status).toBe("rejected");
  });

  it("Autopilot applies a small low-risk lab change by itself", async () => {
    await boot({ mode: "autopilot" });
    const r = await proposeAndMaybeApply({ scopeId: SCOPE, title: "Describe uplink", intent: "label it", source: "assistant", devices: [{ device: "R1", commands: ["interface Gi0/1", "description uplink"] }] });
    expect(r.applied).toBe(true);
    expect(r.change.status).toBe("verified");
    expect(r.change.approvedBy).toBe("autopilot");
  });

  it("Autopilot rolls its own change back when it cannot be verified", async () => {
    await boot({ mode: "autopilot", r1: { host: "R1", config: R1_CFG, ignore: ["description uplink"] } });
    const before = r1.text();
    const r = await proposeAndMaybeApply({ scopeId: SCOPE, title: "x", intent: "x", source: "assistant", devices: [{ device: "R1", commands: ["interface Gi0/1", "description uplink", "no shutdown"] }] });
    expect(r.change.status).toBe("rolled_back");
    expect(remainingDifferences(before, r1.text())).toEqual([]);
  });

  it("Autopilot does nothing unless configuration changes are allowed in Settings", async () => {
    const db = await boot({ mode: "autopilot" });
    saveSettings(db, { autopilotAllowConfig: false });
    const r = await proposeAndMaybeApply({ scopeId: SCOPE, title: "x", intent: "x", source: "assistant", devices: [{ device: "R1", commands: ["interface Gi0/1", "description x"] }] });
    expect(r.applied).toBe(false);
    expect(r.note).toMatch(/allow configuration changes/);
    expect(r1.config).toEqual([]);
  });

  it("Autopilot never changes production and never applies high-risk lines", async () => {
    await boot({ mode: "autopilot", env: "production" });
    const prod = await proposeAndMaybeApply({ scopeId: SCOPE, title: "x", intent: "x", source: "assistant", devices: [{ device: "R1", commands: ["interface Gi0/1", "description x"] }] });
    expect(prod.applied).toBe(false);
    expect(prod.change.status).toBe("proposed");
    expect(prod.note).toMatch(/production/);
    expect(r1.config).toEqual([]);
    r1.close(); r2.close(); setProviders(null); setContext(undefined);
    await boot({ mode: "autopilot", env: "lab" });
    const risky = await proposeAndMaybeApply({ scopeId: SCOPE, title: "x", intent: "x", source: "assistant", devices: [{ device: "R1", commands: ["username bob secret hunter2"] }] });
    expect(risky.applied).toBe(false);
    expect(risky.note).toMatch(/high-risk/);
  });

  it("a production change still goes ahead when a person approves it in Approve mode", async () => {
    await boot({ env: "production" });
    const c = await propose([{ device: "R1", commands: ["interface Gi0/1", "description uplink"] }]);
    expect(c.environment).toBe("production");
    approveChange(c.id);
    expect((await deployChange(c.id)).status).toBe("verified");
  });

  it("never files a change that saves or runs commands from inside the configuration", async () => {
    await boot({ mode: "autopilot" });
    for (const bad of [["do write"], ["wr"], ["WRITE MEMORY"], ["tclsh"], ["event manager applet X", 'action 1.0 cli command "reload"'], ["interface Gi0/1", "Do  Wr  Mem"]]) {
      await expect(propose([{ device: "R1", commands: bad }]), bad.join(" / ")).rejects.toBeInstanceOf(ChangeError);
    }
    expect(r1.sent).not.toContain("configure terminal");
    expect(r1.sent.some((l) => /^(do\s+)?(wr|write)/i.test(l))).toBe(false);
  });

  it("Autopilot never applies event manager, kron or alias: they are high risk and wait for a person", async () => {
    await boot({ mode: "autopilot" });
    for (const line of ["alias exec s show version", "kron policy-list L", "event manager applet WATCH", "ALIAS exec x show ip route", "no kron policy-list L"]) {
      const r = await proposeAndMaybeApply({ scopeId: SCOPE, title: "x", intent: "x", source: "assistant", devices: [{ device: "R1", commands: [line] }] });
      expect(r.applied, line).toBe(false);
      expect(r.change.status, line).toBe("proposed");
      expect(r.note, line).toMatch(/high-risk/);
    }
    expect(r1.config).toEqual([]);
    const c = await propose([{ device: "R1", commands: ["alias exec s show version"] }]);
    expect(autoApprovable(c, "autopilot", true).ok).toBe(false);
  });

  it("a person can still approve a high-risk line in Approve mode, and it is flagged in the plan", async () => {
    await boot();
    const c = await propose([{ device: "R1", commands: ["alias exec s show version"] }]);
    expect(c.plan.devices[0].risks[0].risk).toBe("high");
    expect(c.plan.warnings.join()).toMatch(/high-risk/);
  });

  it("releases the network lock when a deployment fails, so the next change can run", async () => {
    await boot();
    const a = await propose([{ device: "R1", commands: ["interface Gi0/1", "description a"] }], "a");
    approveChange(a.id);
    r1.failShow.on = true;
    expect((await deployChange(a.id)).status).toBe("failed");
    expect(isNetworkBusy(SCOPE)).toBe(false);
    r1.failShow.on = false;
    const b = await propose([{ device: "R1", commands: ["interface Gi0/1", "description b"] }], "b");
    approveChange(b.id);
    expect((await deployChange(b.id)).status).toBe("verified");
    expect(isNetworkBusy(SCOPE)).toBe(false);
  });

  it("does not run two changes on one network at once", async () => {
    await boot();
    const a = await propose([{ device: "R1", commands: ["interface Gi0/1", "description a"] }], "a");
    const b = await propose([{ device: "R2", commands: ["interface Gi0/1", "description b"] }], "b");
    approveChange(a.id); approveChange(b.id);
    const settled = await Promise.allSettled([deployChange(a.id), deployChange(b.id)]);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    expect((settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/Another change is being applied/);
  });
});

describe("the per-network lock", () => {
  afterEach(() => resetChangeLocks());

  it("is held until released, and a second holder is visible as busy", () => {
    const release = acquireNetworkLock("n1");
    expect(isNetworkBusy("n1")).toBe(true);
    expect(isNetworkBusy("n2")).toBe(false);
    release();
    expect(isNetworkBusy("n1")).toBe(false);
  });

  it("a late release from an abandoned run cannot free a lock a newer run now holds", () => {
    const stale = acquireNetworkLock("n1");
    resetChangeLocks(); // the abandoned run's test was reset
    const fresh = acquireNetworkLock("n1");
    stale(); // the abandoned run finishes late
    expect(isNetworkBusy("n1")).toBe(true);
    fresh();
    expect(isNetworkBusy("n1")).toBe(false);
  });

  it("releasing twice is harmless", () => {
    const a = acquireNetworkLock("n1");
    a();
    const b = acquireNetworkLock("n1");
    a();
    expect(isNetworkBusy("n1")).toBe(true);
    b();
  });
});

describe("zero-touch provisioning", () => {
  it("renders a baseline in each dialect", async () => {
    const { renderBaseline } = await import("@/lib/changes/ztp");
    const d = { device: "x", hostname: "edge1", interfaces: [{ name: "Gi0/0", address: "10.0.0.1/30", description: "to core", ospfArea: 0 }], ospf: { processId: 1, routerId: "1.1.1.1", passive: ["Loopback0"] } };
    expect(renderBaseline("ios", d)).toEqual(["hostname edge1", "interface Gi0/0", "description to core", "ip address 10.0.0.1 255.255.255.252", "no shutdown", "ip ospf 1 area 0", "router ospf 1", "router-id 1.1.1.1", "passive-interface Loopback0"]);
    expect(renderBaseline("eos", d)).toEqual(["hostname edge1", "interface Gi0/0", "description to core", "no switchport", "ip address 10.0.0.1/30", "no shutdown", "ip ospf area 0", "router ospf 1", "router-id 1.1.1.1", "passive-interface Loopback0"]);
  });

  it("rejects a plan that could smuggle extra lines in", async () => {
    const { ztpSpec } = await import("@/lib/changes/ztp");
    expect(ztpSpec.safeParse({ devices: [{ device: "R1", interfaces: [{ name: "Gi0/0", address: "10.0.0.1/24", description: "x\nreload" }] }] }).success).toBe(false);
    expect(ztpSpec.safeParse({ devices: [{ device: "R1", hostname: "a b" }] }).success).toBe(false);
    expect(ztpSpec.safeParse({ devices: [{ device: "R1", interfaces: [{ name: "Gi0/0\nreload", address: "10.0.0.1/24" }] }] }).success).toBe(false);
  });
});
