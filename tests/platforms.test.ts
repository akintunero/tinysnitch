import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelFor } from "@/lib/changes/models";
import { approveChange, deployChange, proposeChange, resetChangeLocks, rollbackChange } from "@/lib/changes/engine";
import { renderBaseline } from "@/lib/changes/ztp";
import { assessLine } from "@/lib/core/safety";
import type { DeviceRef } from "@/lib/core/types";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { parseJunosBgpSummary, parseJunosConfig, parseJunosInterfacesTerse, parseJunosOspfNeighbors } from "@/lib/diagnostics/parsers-junos";
import { parseNxosConfig, parseNxosIpIntBrief, parseNxosOspfNeighbors } from "@/lib/diagnostics/parsers-nxos";
import { InventoryError, parseInventory } from "@/lib/providers/inventory-file";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { EapiTransport } from "@/lib/transport/eapi";
import { NetconfTransport } from "@/lib/transport/netconf";
import { NxapiTransport } from "@/lib/transport/nxapi";
import { type FakeEapi, type FakeJunos, type FakeNxapi, startEapi, startJunos, startNxapi } from "./helpers/fake-api";

const mem = () => { const m = new Map<string, string>(); return { get: (i: string) => m.get(i) ?? null, set: (i: string, f: string) => void m.set(i, f) }; };
const ref = (platform: DeviceRef["platform"], label = "D1"): DeviceRef => ({ id: label, label, kind: "router", platform });
const env: Record<string, string | undefined> = { TS_TEST_PW: "secret" };

describe("NX-OS parsers (documented sample output, not a real device)", () => {
  it("reads interface state, OSPF neighbours and the CIDR/ospf-area config forms", () => {
    const rows = parseNxosIpIntBrief(`IP Interface Status for VRF "default"(1)
Interface            IP Address      Interface Status
Vlan1                10.0.0.1        protocol-up/link-up/admin-up
Eth1/1               10.1.1.1        protocol-down/link-down/admin-up
Eth1/2               unassigned      protocol-down/link-down/admin-down`);
    expect(rows.map((r) => [r.name, r.ip, r.status, r.protocol])).toEqual([["Vlan1", "10.0.0.1", "up", "up"], ["Ethernet1/1", "10.1.1.1", "down", "down"], ["Ethernet1/2", null, "administratively down", "down"]]);
    expect(parseNxosOspfNeighbors(" Neighbor ID     Pri State            Up Time  Address         Interface\n 2.2.2.2           1 FULL/DR          00:10:00 10.0.0.2        Eth1/1")).toEqual([{ neighborId: "2.2.2.2", state: "FULL", role: "DR", address: "10.0.0.2", interface: "Ethernet1/1" }]);
    const cfg = parseNxosConfig("hostname n9k\ninterface Ethernet1/1\n  no switchport\n  ip address 10.1.1.1/30\n  ip router ospf 1 area 0.0.0.0\nrouter ospf 1\n  router-id 1.1.1.1");
    expect(cfg.interfaces.get("Ethernet1/1")).toMatchObject({ ip: "10.1.1.1", plen: 30, ospf: { pid: "1", area: "0" } });
    expect(cfg.ospf?.routerId).toBe("1.1.1.1");
  });
});

describe("Junos parsers (documented sample output, not a real device)", () => {
  it("reads show interfaces terse, keyed by physical interface with the inet unit's address", () => {
    const rows = parseJunosInterfacesTerse(`Interface               Admin Link Proto    Local                 Remote
ge-0/0/0                up    up
ge-0/0/0.0              up    up   inet     10.0.0.1/30
                                   multiservice
ge-0/0/1                down  down
lo0                     up    up
lo0.0                   up    up   inet     1.1.1.1           --> 0/0`);
    expect(rows.map((r) => [r.name, r.ip, r.status, r.protocol])).toEqual([["ge-0/0/0", "10.0.0.1", "up", "up"], ["ge-0/0/1", null, "administratively down", "down"], ["Loopback0", "1.1.1.1", "up", "up"]]);
  });
  it("reads OSPF neighbours and BGP peers", () => {
    expect(parseJunosOspfNeighbors("Address          Interface              State     ID               Pri  Dead\n10.0.0.2         ge-0/0/0.0             Full      2.2.2.2          128    33")).toEqual([{ neighborId: "2.2.2.2", state: "FULL", role: "", address: "10.0.0.2", interface: "ge-0/0/0" }]);
    const bgp = parseJunosBgpSummary("Groups: 1 Peers: 2 Down peers: 1\nTable          Tot Paths  Act Paths Suppressed    History Damp State    Pending\nPeer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...\n10.0.0.2              65002         10         12       0       0        4:20 Establ\n  inet.0: 2/3/3/0\n10.0.0.6              65003          0          0       0       1        1:00 Active");
    expect(bgp.map((p) => [p.neighbor, p.state, p.prefixes])).toEqual([["10.0.0.2", "Established", 3], ["10.0.0.6", "Active", null]]);
  });
  it("reads show configuration | display set into the shapes the checks use", () => {
    const cfg = parseJunosConfig(`set system host-name j1
set interfaces ge-0/0/0 description "to core"
set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30
set interfaces ge-0/0/1 disable
set routing-options router-id 1.1.1.1
set routing-options autonomous-system 65001
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0
set protocols ospf area 0.0.0.0 interface lo0.0 passive
set protocols bgp group ext neighbor 10.0.0.2 peer-as 65002`);
    expect(cfg.hostname).toBe("j1");
    expect(cfg.interfaces.get("ge-0/0/0")).toMatchObject({ ip: "10.0.0.1", plen: 30, description: "to core", ospf: { area: "0" } });
    expect(cfg.interfaces.get("ge-0/0/1")?.shutdown).toBe(true);
    expect(cfg.ospf).toMatchObject({ routerId: "1.1.1.1", passive: ["Loopback0"] });
    expect(cfg.bgp).toMatchObject({ asn: "65001", neighbors: [{ ip: "10.0.0.2", remoteAs: "65002" }] });
  });
});

describe("Junos set-line model", () => {
  const m = modelFor("junos");
  const snap = "set interfaces ge-0/0/1 disable\nset interfaces ge-0/0/1 description old\nset interfaces ge-0/0/2 description keep";
  const now = "set interfaces ge-0/0/1 description new\nset interfaces ge-0/0/1 unit 0 family inet address 10.0.1.1/30\nset interfaces ge-0/0/2 description someone-else";
  const plan = ["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description new", "set interfaces ge-0/0/1 unit 0 family inet address 10.0.1.1/30"];
  it("verifies set and delete lines against the displayed configuration", () => {
    expect(m.verify(plan, now).ok).toBe(true);
    const bad = m.verify(["set interfaces ge-0/0/1 disable", "delete interfaces ge-0/0/1 description"], now);
    expect(bad.mismatches.map((x) => x.command)).toEqual(["set interfaces ge-0/0/1 disable", "delete interfaces ge-0/0/1 description"]);
  });
  it("rolls back only what the change touched, replacing single values", () => {
    const rb = m.rollback(snap, now, plan);
    expect(rb.commands).toEqual(expect.arrayContaining(["delete interfaces ge-0/0/1 description new", "delete interfaces ge-0/0/1 unit 0 family inet address 10.0.1.1/30", "set interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description old"]));
    expect(rb.commands.join("\n")).not.toContain("ge-0/0/2");
    expect(rb.commands.findIndex((c) => c.startsWith("delete"))).toBeLessThan(rb.commands.findIndex((c) => c.startsWith("set"))); // deletes first
  });
  it("sees a management cut-off", () => {
    const cfg = "set interfaces fxp0 unit 0 family inet address 10.9.9.9/24";
    expect(m.cutoff(cfg, "junos", "10.9.9.9", ["set interfaces fxp0 disable"])).toMatch(/disable.*10\.9\.9\.9/);
    expect(m.cutoff(cfg, "junos", "10.9.9.9", ["set interfaces ge-0/0/0 disable"])).toBeNull();
  });
});

describe("safety rules for the new dialects", () => {
  it("blocks Junos operational and commit commands, and flags access-changing lines", () => {
    for (const l of ["request system reboot", "rollback 1", "commit", "run show version", "load override x", "request system zeroize", "show version", "interface ge-0/0/0"]) expect(assessLine(l, "junos").risk, l).toBe("blocked");
    for (const l of ["set system login user bob class super-user", "delete system services ssh", "set system host-name x", "delete interfaces ge-0/0/1", "delete protocols ospf"]) expect(assessLine(l, "junos").risk, l).toBe("high");
    for (const l of ["set interfaces ge-0/0/1 description x", "delete interfaces ge-0/0/1 disable"]) expect(assessLine(l, "junos").risk, l).toBe("normal");
    expect(assessLine("no feature bgp", "nxos").risk).toBe("high");
    expect(assessLine("feature ospf", "nxos").risk).toBe("normal");
    expect(assessLine("delete flash:config.txt", "ios").risk).toBe("blocked"); // on IOS, delete still erases a file
  });
});

describe("inventory transports", () => {
  const base = (dev: string, extra = "") => `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\n  k: { username: admin, privateKey: "file:/k" }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n${extra}    devices:\n      - { name: D1, address: 10.0.0.1, ${dev} }\n`;
  it("accepts each transport on its own platform", () => {
    for (const d of ["platform: junos, transport: netconf", "platform: eos, transport: eapi", "platform: nxos, transport: nxapi"]) expect(parseInventory(base(d)).sites[0].devices[0].transport).toBe(d.split(": ").pop());
  });
  it("rejects a transport on the wrong platform, a key-only credential for an API, and plain http to a remote host", () => {
    expect(() => parseInventory(base("platform: ios, transport: eapi"))).toThrow(/for eos devices, not ios/);
    expect(() => parseInventory(base("platform: eos, transport: eapi, credential: k"))).toThrow(/password reference/);
    expect(() => parseInventory(base("platform: eos, transport: eapi, scheme: http"))).toThrow(/only allowed to a local address/);
    expect(() => parseInventory(base("platform: ios, scheme: https"))).toThrow(/eapi and nxapi transports only/);
    expect(() => parseInventory(base("platform: eos, transport: carrierpigeon"))).toThrow(InventoryError);
  });
});

describe("provisioning baselines for the new dialects", () => {
  const d = { device: "x", hostname: "edge1", interfaces: [{ name: "Ethernet1/1", address: "10.0.0.1/30", ospfArea: 0 }], ospf: { processId: 1, routerId: "1.1.1.1", passive: [] as string[] } };
  it("renders NX-OS", () => expect(renderBaseline("nxos", d)).toEqual(["hostname edge1", "feature ospf", "interface Ethernet1/1", "no switchport", "ip address 10.0.0.1/30", "no shutdown", "ip router ospf 1 area 0", "router ospf 1", "router-id 1.1.1.1"]));
  it("renders Junos set lines", () => expect(renderBaseline("junos", { ...d, interfaces: [{ name: "ge-0/0/0", address: "10.0.0.1/30", ospfArea: 0 }] })).toEqual(["set system host-name edge1", "set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30", "delete interfaces ge-0/0/0 disable", "set protocols ospf area 0 interface ge-0/0/0.0", "set routing-options router-id 1.1.1.1"]));
});

describe("eAPI transport", () => {
  let e: FakeEapi;
  afterEach(() => e?.close());
  const tr = (over: Partial<{ pass: string }> = {}) => new EapiTransport(() => ({ label: "D1", host: "127.0.0.1", port: e.port, username: "admin", password: "env:TS_TEST_PW", scheme: "http" }), { TS_TEST_PW: over.pass ?? "secret" });
  it("reads, refuses non-show commands before sending them, and masks secrets", async () => {
    e = await startEapi({ config: "hostname E1\nusername admin secret 5 $1$abcd$abcdefghijklmnop\ninterface Ethernet1\n   ip address 10.0.0.1/24" });
    const r = await tr().run(ref("eos"), "show running-config");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hostname E1");
    expect(r.text).not.toContain("$1$abcd$abcdefghijklmnop");
    expect((await tr().run(ref("eos"), "configure terminal")).ok).toBe(false);
    expect((await tr().run(ref("eos"), "show version; reload")).ok).toBe(false);
    expect(e.requests.flat()).not.toContain("reload");
  });
  it("says plainly when the login is refused", async () => {
    e = await startEapi({ config: "hostname E1" });
    const r = await tr({ pass: "wrong" }).run(ref("eos"), "show running-config");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/login was refused/);
    expect(r.text).not.toContain("wrong");
  });
  it("applies lines, and names the line the switch rejected", async () => {
    e = await startEapi({ config: "hostname E1\ninterface Ethernet1\n   shutdown" });
    const ok = await tr().push(ref("eos"), ["interface Ethernet1", "description up", "no shutdown"]);
    expect(ok).toMatchObject({ ok: true, failedAt: null });
    expect(e.requests.at(-1)?.slice(0, 2)).toEqual(["enable", "configure"]);
    const bad = await tr().push(ref("eos"), ["interface Ethernet1", "bogus thing", "description never"]);
    expect(bad).toMatchObject({ ok: false, failedAt: "bogus thing", applied: ["interface Ethernet1"] });
    expect((await tr().push(ref("eos"), ["reload"])).text).toMatch(/Refused before sending anything/);
  });
  it("refuses plain http to a remote host", async () => {
    const t = new EapiTransport(() => ({ label: "D1", host: "192.0.2.1", port: 80, username: "admin", password: "env:TS_TEST_PW", scheme: "http" }), env);
    expect((await t.run(ref("eos"), "show version")).text).toMatch(/only allowed to a local address/);
  });
});

describe("NX-API transport", () => {
  let n: FakeNxapi;
  afterEach(() => n?.close());
  const tr = () => new NxapiTransport(() => ({ label: "D1", host: "127.0.0.1", port: n.port, username: "admin", password: "env:TS_TEST_PW", scheme: "http" }), env);
  it("reads with cli_show_ascii and applies with cli_conf joined by ' ;'", async () => {
    n = await startNxapi({ config: "hostname N1\ninterface Ethernet1/1\n  shutdown" });
    expect((await tr().run(ref("nxos"), "show running-config")).text).toContain("hostname N1");
    const r = await tr().push(ref("nxos"), ["interface Ethernet1/1", "description up", "no shutdown"]);
    expect(r.ok).toBe(true);
    expect(n.requests.at(-1)).toEqual({ type: "cli_conf", input: "interface Ethernet1/1 ;description up ;no shutdown" });
    expect(n.cfg.blocks.get("interface Ethernet1/1")).toEqual(["description up"]);
  });
  it("names the rejected line and refuses what must never be sent", async () => {
    n = await startNxapi({ config: "hostname N1" });
    const bad = await tr().push(ref("nxos"), ["interface Ethernet1/1", "bogus thing", "description never"]);
    expect(bad).toMatchObject({ ok: false, failedAt: "bogus thing" });
    expect((await tr().run(ref("nxos"), "write erase")).ok).toBe(false);
    expect((await tr().push(ref("nxos"), ["no feature bgp ; reload"])).ok).toBe(false);
  });
  it("only claims to push to NX-OS", () => expect(tr().pushSupport(ref("eos"))).toMatchObject({ ok: false }));
});

describe("NETCONF transport (Junos)", () => {
  let j: FakeJunos;
  afterEach(() => j?.close());
  const CFG = ["set system host-name J1", "set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30", "set interfaces ge-0/0/1 disable"];
  const tr = () => new NetconfTransport(() => ({ label: "D1", host: "127.0.0.1", port: j.port, username: "admin", password: "env:TS_TEST_PW" }), { hostKeys: mem(), env, connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

  it("runs read-only commands through the command RPC and refuses the rest", async () => {
    j = await startJunos({ config: CFG });
    const t = tr();
    const r = await t.run(ref("junos"), "show configuration | display set");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("set system host-name J1");
    expect((await t.run(ref("junos"), "show nonsense")).text).toMatch(/syntax error/);
    expect((await t.run(ref("junos"), "request system reboot")).ok).toBe(false);
    expect(j.rpcs.join()).not.toContain("reboot");
    t.closeAll();
  });

  it("commits provisionally and leaves it to be confirmed; a final push is permanent at once", async () => {
    j = await startJunos({ config: CFG });
    const t = tr();
    const r = await t.push(ref("junos"), ["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description up"]);
    expect(r).toMatchObject({ ok: true, failedAt: null });
    expect(j.pending).toBe(true);
    expect(j.committed.has("set interfaces ge-0/0/1 disable")).toBe(false);
    expect(j.locked).toBe(false);
    j.revertPending(); // the device's confirm timer ends without a confirm
    expect(j.committed.has("set interfaces ge-0/0/1 disable")).toBe(true);
    await t.push(ref("junos"), ["set interfaces ge-0/0/1 description up"]);
    expect((await t.confirm!(ref("junos"))).ok).toBe(true);
    expect(j.pending).toBe(false);
    const f = await t.push(ref("junos"), ["set interfaces ge-0/0/1 description final"], { final: true });
    expect(f.ok).toBe(true);
    expect(j.pending).toBe(false);
    t.closeAll();
  });

  it("throws the candidate away and unlocks when the device rejects a line", async () => {
    j = await startJunos({ config: CFG });
    const t = tr();
    const bad = await t.push(ref("junos"), ["set interfaces ge-0/0/1 description ok", "set bogus thing"]);
    expect(bad.ok).toBe(false);
    expect(bad.failedAt).toBe("set bogus thing");
    expect(bad.text).toMatch(/rejected the change/);
    expect(j.candidate).toEqual(j.committed); // nothing half-entered is left behind
    expect(j.locked).toBe(false);
    expect(j.pending).toBe(false);
    t.closeAll();
  });

  it("refuses blocked and non-Junos lines before any RPC, and only claims Junos", async () => {
    j = await startJunos({ config: CFG });
    const t = tr();
    expect((await t.push(ref("junos"), ["request system reboot"])).text).toMatch(/Refused before sending anything/);
    expect((await t.push(ref("junos"), ["interface ge-0/0/0"])).text).toMatch(/not a Junos set or delete line/);
    expect(j.rpcs.filter((x) => x.includes("lock"))).toEqual([]);
    expect(t.pushSupport(ref("ios"))).toMatchObject({ ok: false });
    t.closeAll();
  });
});

describe("the change workflow over each API transport", () => {
  let devs: { close: () => void }[] = [];
  afterEach(() => { for (const d of devs) d.close(); devs = []; setProviders(null); setContext(undefined); resetChangeLocks(); });

  function boot(device: string, mode: "approve" | "autopilot" = "approve") {
    process.env.TS_TEST_PW = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-api-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: D1, address: 127.0.0.1, kind: router, ${device} }\n`);
    const db = openDatabase(":memory:");
    saveSettings(db, { executionMode: mode, autopilotAllowConfig: true });
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
  }
  const run = async (commands: string[]) => {
    const c = await proposeChange({ scopeId: "static:s", title: "t", intent: "t", source: "user", devices: [{ device: "D1", commands }] });
    approveChange(c.id);
    return deployChange(c.id);
  };

  it("EOS over eAPI: diagnostics, apply, verify, roll back", async () => {
    const e = await startEapi({ config: "hostname E1\ninterface Ethernet1\n   ip address 10.0.0.1/24\ninterface Ethernet2\n   shutdown" });
    devs.push(e);
    boot(`port: ${e.port}, platform: eos, transport: eapi, scheme: http`);
    const diag = await runDiagnostics("static:s", { pings: false });
    expect(diag.run.devices[0]).toMatchObject({ label: "D1", inspected: true, commandsFailed: 0 });
    expect(diag.run.notRun.join()).toMatch(/Arista EOS/);
    const done = await run(["interface Ethernet2", "description uplink", "no shutdown"]);
    expect(done.status).toBe("verified");
    expect(e.cfg.blocks.get("interface Ethernet2")).toEqual(["description uplink"]);
    const rb = await rollbackChange(done.id);
    expect(rb.status).toBe("rolled_back");
    expect(e.cfg.blocks.get("interface Ethernet2")).toEqual(["shutdown"]);
  });

  it("EOS over eAPI: a rejected line leaves the device as it was", async () => {
    const e = await startEapi({ config: "hostname E1\ninterface Ethernet2\n   shutdown" });
    devs.push(e);
    boot(`port: ${e.port}, platform: eos, transport: eapi, scheme: http`);
    const done = await run(["interface Ethernet2", "description x", "bogus thing"]);
    expect(done.status).toBe("rolled_back");
    expect(e.cfg.blocks.get("interface Ethernet2")).toEqual(["shutdown"]);
  });

  it("NX-OS over NX-API: diagnostics, apply, verify, roll back", async () => {
    const n = await startNxapi({ config: "hostname N1\ninterface Ethernet1/1\n  ip address 10.0.0.1/24\ninterface Ethernet1/2\n  shutdown" });
    devs.push(n);
    boot(`port: ${n.port}, platform: nxos, transport: nxapi, scheme: http`);
    const diag = await runDiagnostics("static:s", { pings: false });
    expect(diag.run.devices[0]).toMatchObject({ inspected: true, commandsFailed: 0 });
    const done = await run(["interface Ethernet1/2", "description uplink", "no shutdown"]);
    expect(done.status).toBe("verified");
    const rb = await rollbackChange(done.id);
    expect(rb.status).toBe("rolled_back");
    expect(n.cfg.blocks.get("interface Ethernet1/2")).toEqual(["shutdown"]);
  });

  it("Junos over NETCONF: diagnostics, provisional apply, verify, confirm, roll back", async () => {
    const j = await startJunos({ config: ["set system host-name J1", "set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30", "set interfaces ge-0/0/1 disable"] });
    devs.push(j);
    boot(`port: ${j.port}, platform: junos, transport: netconf`);
    const diag = await runDiagnostics("static:s", { pings: false });
    expect(diag.run.devices[0]).toMatchObject({ inspected: true, commandsFailed: 0 });
    const done = await run(["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description uplink"]);
    expect(done.status).toBe("verified");
    expect(done.result?.devices[0].steps.join(" ")).toMatch(/Confirmed: the change is now permanent/);
    expect(j.pending).toBe(false); // confirmed only after it was read back
    expect(j.committed.has("set interfaces ge-0/0/1 disable")).toBe(false);
    const rb = await rollbackChange(done.id);
    expect(rb.status).toBe("rolled_back");
    expect(j.pending).toBe(false);
    expect(j.committed.has("set interfaces ge-0/0/1 disable")).toBe(true);
    expect([...j.committed].some((l) => l.includes("description"))).toBe(false);
  });

  it("Junos: a change that cannot be verified is never confirmed, so the device reverts it by itself", async () => {
    const j = await startJunos({ config: ["set system host-name J1", "set interfaces ge-0/0/1 disable"] });
    devs.push(j);
    j.ignore.add("set interfaces ge-0/0/1 description uplink"); // accepted, silently not applied
    boot(`port: ${j.port}, platform: junos, transport: netconf`);
    const done = await run(["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description uplink"]);
    expect(done.status).toBe("failed");
    expect(done.result?.devices[0].verified).toBe(false);
    expect(j.pending).toBe(true); // still provisional: it will revert when the timer ends
    j.revertPending();
    expect(j.committed.has("set interfaces ge-0/0/1 disable")).toBe(true);
  });

  it("Junos over plain SSH cannot be changed: the proposal is refused with the reason", async () => {
    const j = await startJunos({ config: ["set system host-name J1"] });
    devs.push(j);
    boot(`port: ${j.port}, platform: junos`);
    await expect(proposeChange({ scopeId: "static:s", title: "t", intent: "t", source: "user", devices: [{ device: "D1", commands: ["set system ntp server 10.0.0.9"] }] })).rejects.toThrow(/need a NETCONF connection/);
  });
});
