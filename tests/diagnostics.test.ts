import { describe, expect, it } from "vitest";
import type { TopoLink, TopoNode, Topology } from "@/lib/cml/topology";
import { analyse } from "@/lib/diagnostics/checks";
import { CMD, type CommandKey } from "@/lib/diagnostics/commands";
import {
  normIf, ospfFor, parseBgpSummary, parseEtherchannel, parseIpIntBrief, parseOspfNeighbors, parsePing, parseRunningConfig, parseTrunk, parseVlanBrief,
} from "@/lib/diagnostics/parsers";
import { deriveFromRun } from "@/lib/diagnostics/state";
import type { DeviceSnapshot, Finding, PingResult, RunSummary } from "@/lib/diagnostics/types";

// ---- fixtures: output laid out the way IOS prints it -------------------------------------------------------
const BRIEF_HEAD = "Interface                  IP-Address      OK? Method Status                Protocol\n";
const brief = (rows: [string, string, string, string][]) => BRIEF_HEAD + rows.map(([n, ip, s, p]) => `${n.padEnd(26)} ${ip.padEnd(15)} YES manual ${s.padEnd(21)} ${p}`).join("\n") + "\n";
const OSPF_HEAD = "Neighbor ID     Pri   State           Dead Time   Address         Interface\n";
const ospf = (rows: [string, string, string, string, string][]) => OSPF_HEAD + rows.map(([id, st, role, addr, ifc]) => `${id.padEnd(15)} 1   ${(st + (role ? "/" + role : "")).padEnd(15)} 00:00:33    ${addr.padEnd(15)} ${ifc}`).join("\n") + "\n";

type IfaceSpec = { name: string; ip?: string; mask?: string; shutdown?: boolean; mtu?: number; area?: string; extra?: string[] };
const cfg = (host: string, ifaces: IfaceSpec[], router = "") =>
  [`hostname ${host}`, "!", ...ifaces.flatMap((i) => [`interface ${i.name}`, i.ip ? ` ip address ${i.ip} ${i.mask ?? "255.255.255.252"}` : " no ip address", ...(i.mtu ? [` mtu ${i.mtu}`] : []), ...(i.area !== undefined ? [` ip ospf 1 area ${i.area}`] : []), ...(i.extra ?? []).map((e) => ` ${e}`), ...(i.shutdown ? [" shutdown"] : []), "!"]), router].join("\n");

const node = (id: string, label: string, kind: TopoNode["kind"], state = "BOOTED"): TopoNode => ({ id, label, kind, definition: "x", state, bootProgress: null, x: 0, y: 0, interfaces: [] });
const link = (id: string, s: string, si: string, t: string, ti: string): TopoLink => ({ id, source: s, target: t, sourceInterface: si, targetInterface: ti, cmlState: "STARTED", status: "not_inspected", statusText: "" });
const topo = (nodes: TopoNode[], links: TopoLink[]): Topology => ({ lab: { id: "L", title: "Test", state: "STARTED" }, nodes, links, fetchedAt: "", warnings: [] });
const snap = (n: TopoNode, cmds: Partial<Record<CommandKey, string>>): DeviceSnapshot => ({
  nodeId: n.id, label: n.label, kind: n.kind,
  commands: Object.fromEntries(Object.entries(cmds).map(([k, v]) => [CMD[k as CommandKey], { ok: true, text: v as string }])),
});
const run = (t: Topology, snaps: DeviceSnapshot[], pings: PingResult[] = []) => analyse(t, new Map(snaps.map((s) => [s.nodeId, s])), pings);
const kinds = (fs: Finding[]) => fs.map((f) => f.kind).sort();

const G0 = "GigabitEthernet0/0";
const R1 = node("n1", "R1", "router"), R2 = node("n2", "R2", "router");
const L = link("l1", "n1", G0, "n2", G0);
const T2 = topo([R1, R2], [L]);
const UPUP: [string, string, string, string][] = [[G0, "10.0.12.1", "up", "up"]];
const upBrief = (ip: string) => brief([[G0, ip, "up", "up"]]);
const OSPF_ROUTER = (extra = "") => `router ospf 1\n router-id 1.1.1.1\n network 10.0.12.0 0.0.0.3 area 0\n${extra}`;

/** A healthy pair, with overrides per device for each scenario. */
function pair(o: { r1?: Partial<Record<CommandKey, string>>; r2?: Partial<Record<CommandKey, string>>; ifc1?: IfaceSpec; ifc2?: IfaceSpec; ospf1?: string; ospf2?: string } = {}) {
  const ifc1 = o.ifc1 ?? { name: G0, ip: "10.0.12.1" }, ifc2 = o.ifc2 ?? { name: G0, ip: "10.0.12.2" };
  const full: [string, string, string, string, string][] = [["2.2.2.2", "FULL", "DR", "10.0.12.2", G0]];
  const full2: [string, string, string, string, string][] = [["1.1.1.1", "FULL", "BDR", "10.0.12.1", G0]];
  return [
    snap(R1, { brief: upBrief("10.0.12.1"), config: cfg("R1", [ifc1], o.ospf1 ?? OSPF_ROUTER()), ospf: ospf(full), ...o.r1 }),
    snap(R2, { brief: upBrief("10.0.12.2"), config: cfg("R2", [ifc2], o.ospf2 ?? OSPF_ROUTER().replace("1.1.1.1", "2.2.2.2")), ospf: ospf(full2), ...o.r2 }),
  ];
}

describe("parsers", () => {
  it("normalises interface names", () => {
    expect([normIf("Gi0/1"), normIf("GigabitEthernet0/1"), normIf("Et0/0"), normIf("Po1"), normIf("Lo0"), normIf("weird")]).toEqual(["GigabitEthernet0/1", "GigabitEthernet0/1", "Ethernet0/0", "Port-channel1", "Loopback0", "weird"]);
  });
  it("reads show ip interface brief, including administratively down and unassigned", () => {
    const rows = parseIpIntBrief(brief([[G0, "10.0.12.1", "up", "up"], ["GigabitEthernet0/1", "unassigned", "administratively down", "down"], ["Loopback0", "1.1.1.1", "up", "up"]]));
    expect(rows).toEqual([
      { name: G0, ip: "10.0.12.1", status: "up", protocol: "up" },
      { name: "GigabitEthernet0/1", ip: null, status: "administratively down", protocol: "down" },
      { name: "Loopback0", ip: "1.1.1.1", status: "up", protocol: "up" },
    ]);
  });
  it("reads OSPF neighbours with and without a role", () => {
    const rows = parseOspfNeighbors(ospf([["2.2.2.2", "FULL", "DR", "10.0.12.2", "Gi0/0"], ["3.3.3.3", "FULL", "-", "10.0.13.2", G0], ["4.4.4.4", "EXSTART", "BDR", "10.0.24.2", G0]]));
    expect(rows.map((r) => [r.neighborId, r.state, r.role, r.interface])).toEqual([["2.2.2.2", "FULL", "DR", G0], ["3.3.3.3", "FULL", "-", G0], ["4.4.4.4", "EXSTART", "BDR", G0]]);
  });
  it("reads BGP peers", () => {
    const rows = parseBgpSummary("Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n10.0.0.2        4        65002      10      10        3    0    0 00:05:00        2\n10.0.0.3        4        65003       0       0        1    0    0 never    Idle (Admin)\n");
    expect(rows.map((r) => [r.neighbor, r.state, r.prefixes])).toEqual([["10.0.0.2", "Established", 2], ["10.0.0.3", "Idle (Admin)", null]]);
  });
  it("reads the running configuration: addressing, mtu, ospf, switchport and bgp", () => {
    const c = parseRunningConfig(`hostname SW1\ninterface Ethernet0/0\n ip address 10.0.12.1 255.255.255.252\n mtu 1400\n ip ospf 1 area 1\n shutdown\n!\ninterface Ethernet0/1\n switchport mode trunk\n switchport trunk native vlan 99\n switchport trunk allowed vlan 10,20\n channel-group 1 mode active\n!\ninterface Ethernet0/2\n switchport mode access\n switchport access vlan 10\n!\nrouter ospf 1\n router-id 9.9.9.9\n passive-interface default\n no passive-interface Ethernet0/0\n network 10.0.12.0 0.0.0.3 area 0\n!\nrouter bgp 65000\n bgp router-id 8.8.8.8\n neighbor 10.0.0.2 remote-as 65002\n neighbor 10.0.0.3 shutdown\n`);
    expect(c.hostname).toBe("SW1");
    expect(c.interfaces.get("Ethernet0/0")).toMatchObject({ ip: "10.0.12.1", plen: 30, mtu: 1400, shutdown: true, ospf: { pid: "1", area: "1" } });
    expect(c.interfaces.get("Ethernet0/1")).toMatchObject({ mode: "trunk", nativeVlan: 99, allowed: "10,20", channelGroup: 1 });
    expect(c.interfaces.get("Ethernet0/2")).toMatchObject({ mode: "access", accessVlan: 10 });
    expect(c.ospf).toMatchObject({ routerId: "9.9.9.9", passiveDefault: true, noPassive: ["Ethernet0/0"] });
    expect(c.bgp).toMatchObject({ asn: "65000", routerId: "8.8.8.8", neighbors: [{ ip: "10.0.0.2", remoteAs: "65002", shutdown: false }, { ip: "10.0.0.3", shutdown: true }] });
  });
  it("works out which interfaces OSPF covers, by interface command, network statement and passive rules", () => {
    const c = parseRunningConfig(`interface Ethernet0/0\n ip address 10.0.12.1 255.255.255.252\ninterface Ethernet0/1\n ip address 10.0.13.1 255.255.255.252\n ip ospf 1 area 2\ninterface Ethernet0/2\n ip address 192.168.9.1 255.255.255.0\nrouter ospf 1\n passive-interface default\n no passive-interface Ethernet0/0\n network 10.0.12.0 0.0.0.3 area 0\n`);
    expect(ospfFor(c, c.interfaces.get("Ethernet0/0")!)).toEqual({ area: "0", passive: false });
    expect(ospfFor(c, c.interfaces.get("Ethernet0/1")!)).toEqual({ area: "2", passive: true });
    expect(ospfFor(c, c.interfaces.get("Ethernet0/2")!)).toBeNull();
  });
  it("reads VLAN membership, trunks and etherchannels", () => {
    const vlans = parseVlanBrief("VLAN Name                             Status    Ports\n---- -------------------------------- --------- ----------\n1    default                          active    Et0/0, Et0/1\n10   Sales                            active    Et0/2\n                                                Et0/3\n20   IT                               active\n");
    expect([...vlans]).toEqual([["Ethernet0/0", "1"], ["Ethernet0/1", "1"], ["Ethernet0/2", "10"], ["Ethernet0/3", "10"]]);
    const trunks = parseTrunk("Port        Mode             Encapsulation  Status        Native vlan\nEt0/0       on               802.1q         trunking      99\nEt0/1       auto             802.1q         not-trunking  1\n\nPort        Vlans allowed on trunk\nEt0/0       1-4094\nEt0/1       1-4094\n\nPort        Vlans allowed and active in management domain\nEt0/0       1,10\n");
    expect(trunks[0]).toMatchObject({ port: "Ethernet0/0", status: "trunking", native: "99", allowed: "1-4094" });
    expect(trunks).toHaveLength(2);
    const ec = parseEtherchannel("Group  Port-channel  Protocol    Ports\n------+-------------+-----------+-----------------------------------------------\n1      Po1(SU)         LACP      Gi0/0(P)    Gi0/1(s)\n");
    expect(ec).toEqual([{ group: 1, portChannel: "Port-channel1", flags: "SU", protocol: "LACP", members: [{ port: "GigabitEthernet0/0", flag: "P" }, { port: "GigabitEthernet0/1", flag: "s" }] }]);
  });
  it("reads ping results and refuses to guess when there are none", () => {
    expect(parsePing("Type escape sequence to abort.\n!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms")).toEqual({ successRate: 100, received: 5, sent: 5 });
    expect(parsePing(".....\nSuccess rate is 0 percent (0/5)")).toMatchObject({ successRate: 0 });
    expect(parsePing("% Invalid input detected")).toBeNull();
  });
});

describe("interface checks", () => {
  it("finds nothing wrong on a healthy link and records what each interface reported", () => {
    const r = run(T2, pair());
    expect(r.findings).toEqual([]);
    expect(r.interfaces.n1[G0]).toEqual({ status: "up", protocol: "up", ip: "10.0.12.1" });
  });
  it("flags an administratively down interface only when the other end is not also down", () => {
    // With R2 shut, R1's side really does show down/down.
    const r = run(T2, pair({ r1: { brief: brief([[G0, "10.0.12.1", "down", "down"]]) }, r2: { brief: brief([[G0, "10.0.12.2", "administratively down", "down"]]) } }));
    const f = r.findings.find((x) => x.kind === "interface-admin-down")!;
    expect(f).toMatchObject({ device: "R2", interface: G0, status: "confirmed", severity: "warning", linkId: "l1", peer: { device: "R1" } });
    expect(f.evidence[0]).toContain(`R2# ${CMD.brief}: ${G0} 10.0.12.2 administratively down/down`);
    const down = r.findings.find((x) => x.kind === "interface-down")!;
    expect(down).toMatchObject({ device: "R1", severity: "critical" });
    expect(down.probableCause).toMatch(/R2 GigabitEthernet0\/0 is administratively down/);
  });
  it("does not flag a spare link that is shut at both ends", () => {
    const shut = brief([[G0, "unassigned", "administratively down", "down"]]);
    expect(run(T2, pair({ r1: { brief: shut }, r2: { brief: shut } })).findings).toEqual([]);
  });
  it("flags line protocol down as critical, and says when the peer is not running", () => {
    const stopped = { ...R2, state: "STOPPED" };
    const r = run(topo([R1, stopped], [L]), [pair({ r1: { brief: brief([[G0, "10.0.12.1", "up", "down"]]) } })[0]]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: "interface-down", title: "Line protocol down" });
    expect(r.findings[0].probableCause).toMatch(/not responding|not running/);
  });
  it("marks an addressless connected router interface as suspected, never confirmed", () => {
    const r = run(T2, pair({ r1: { brief: brief([[G0, "unassigned", "up", "up"]]) } }));
    expect(r.findings.find((f) => f.kind === "no-ip")).toMatchObject({ status: "suspected", severity: "warning" });
  });
});

describe("OSPF checks", () => {
  const noNbrs = { ospf: OSPF_HEAD };
  const cause = (r: ReturnType<typeof run>) => r.findings.find((f) => f.kind === "ospf-adjacency-missing")!;

  it("is silent when both neighbours are FULL", () => {
    expect(run(T2, pair()).findings).toEqual([]);
  });
  it("confirms an area mismatch as the cause of a missing adjacency", () => {
    const f = cause(run(T2, pair({ r1: noNbrs, r2: noNbrs, ifc2: { name: G0, ip: "10.0.12.2", area: "1" } })));
    expect(f).toMatchObject({ status: "confirmed", severity: "critical" });
    expect(f.probableCause).toMatch(/area mismatch: area 0 .* area 1/);
    expect(f.evidence.join("\n")).toContain(`R1# ${CMD.ospf}: no neighbour on ${G0}`);
  });
  it("confirms a passive interface", () => {
    const f = cause(run(T2, pair({ r1: noNbrs, r2: noNbrs, ospf2: OSPF_ROUTER(" passive-interface GigabitEthernet0/0\n") })));
    expect(f.status).toBe("confirmed");
    expect(f.probableCause).toMatch(/passive/);
  });
  it("confirms OSPF missing on one end", () => {
    const f = cause(run(T2, pair({ r1: noNbrs, r2: noNbrs, ospf2: "router ospf 1\n router-id 2.2.2.2\n network 192.168.0.0 0.0.255.255 area 0\n" })));
    expect(f.probableCause).toMatch(/OSPF is not enabled on R2/);
  });
  it("confirms a mask mismatch", () => {
    const f = cause(run(T2, pair({ r1: noNbrs, r2: noNbrs, ifc2: { name: G0, ip: "10.0.12.2", mask: "255.255.255.248" } })));
    expect(f.probableCause).toMatch(/mask mismatch: \/30 .* \/29/i);
  });
  it("only suspects a missing adjacency when the configuration explains nothing", () => {
    const f = cause(run(T2, pair({ r1: noNbrs, r2: noNbrs })));
    expect(f).toMatchObject({ status: "suspected" });
    expect(f.verification).toMatch(/Suspected/);
  });
  it("confirms an MTU mismatch behind a neighbour stuck in EXSTART", () => {
    const stuck = (id: string, addr: string): { ospf: string } => ({ ospf: ospf([[id, "EXSTART", "BDR", addr, G0]]) });
    const r = run(T2, pair({ r1: stuck("2.2.2.2", "10.0.12.2"), r2: stuck("1.1.1.1", "10.0.12.1"), ifc2: { name: G0, ip: "10.0.12.2", mtu: 1400 } }));
    const f = r.findings.find((x) => x.kind === "ospf-not-full")!;
    expect(f).toMatchObject({ status: "confirmed", severity: "warning" });
    expect(f.probableCause).toMatch(/MTU mismatch: 1500 on R1 versus 1400 on R2/);
    expect(f.evidence.some((e) => e.includes("mtu 1400"))).toBe(true);
  });
  it("only suspects a stuck neighbour when the MTUs match", () => {
    const stuck = { ospf: ospf([["2.2.2.2", "EXSTART", "BDR", "10.0.12.2", G0]]) };
    expect(run(T2, pair({ r1: stuck })).findings.find((x) => x.kind === "ospf-not-full")).toMatchObject({ status: "suspected", severity: "critical" });
  });
  it("says nothing about OSPF when the neighbour command was refused", () => {
    const refused = (s: DeviceSnapshot) => ({ ...s, commands: { ...s.commands, [CMD.ospf]: { ok: true, text: "% Invalid input detected at '^' marker." } } });
    expect(run(T2, pair().map(refused)).findings).toEqual([]);
  });
  it("skips a link whose interfaces are down, leaving it to the interface findings", () => {
    const r = run(T2, pair({ r1: { ...noNbrs, brief: brief([[G0, "10.0.12.1", "up", "down"]]) }, r2: noNbrs }));
    expect(kinds(r.findings)).toEqual(["interface-down"]);
  });
});

describe("BGP checks", () => {
  const bgp = (state: string) => `Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n10.0.12.2       4        65002       0       0        1    0    0 never    ${state}\n`;
  it("confirms a peer that is not established and points at the peer's own interface", () => {
    const r = run(T2, [pair()[0], pair({ r2: { brief: brief([[G0, "10.0.12.2", "administratively down", "down"]]) } })[1]].map((s, i) => (i === 0 ? { ...s, commands: { ...s.commands, [CMD.bgp]: { ok: true, text: bgp("Active") } } } : s)));
    const f = r.findings.find((x) => x.kind === "bgp-peer-down")!;
    expect(f).toMatchObject({ device: "R1", status: "confirmed", peer: { device: "R2" } });
    expect(f.probableCause).toMatch(/R2 GigabitEthernet0\/0, which is administratively down/);
  });
  it("is silent for established peers", () => {
    const text = bgp("2").replace("never", "00:05:00");
    const s = pair()[0];
    expect(run(T2, [{ ...s, commands: { ...s.commands, [CMD.bgp]: { ok: true, text } } }]).findings).toEqual([]);
  });
});

describe("switching checks", () => {
  const S1 = node("s1", "SW1", "l2switch"), S2 = node("s2", "SW2", "l2switch");
  const SL = link("sl", "s1", "Ethernet0/0", "s2", "Ethernet0/0");
  const TS = topo([S1, S2], [SL]);
  const trunk = (native: string, allowed = "1-4094") => `Port        Mode             Encapsulation  Status        Native vlan\nEt0/0       on               802.1q         trunking      ${native}\n\nPort        Vlans allowed on trunk\nEt0/0       ${allowed}\n`;
  const access = (vlan: string) => `VLAN Name                             Status    Ports\n---- -------------------------------- --------- ----------\n${vlan}   v${vlan}                          active    Et0/0\n`;
  const sws = (a: Partial<Record<CommandKey, string>>, b: Partial<Record<CommandKey, string>>) => [snap(S1, { vlan: "", trunk: "", ...a }), snap(S2, { vlan: "", trunk: "", ...b })];

  it("confirms a native VLAN mismatch", () => {
    const f = run(TS, sws({ trunk: trunk("99") }, { trunk: trunk("1") })).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "native-vlan-mismatch", status: "confirmed" });
    expect(f[0].evidence).toHaveLength(2);
  });
  it("confirms a VLAN mismatch across access ports", () => {
    expect(kinds(run(TS, sws({ vlan: access("10") }, { vlan: access("20") })).findings)).toEqual(["vlan-mismatch"]);
  });
  it("confirms a trunk against an access port", () => {
    expect(kinds(run(TS, sws({ trunk: trunk("1") }, { vlan: access("1") })).findings)).toEqual(["trunk-access-mismatch"]);
  });
  it("only suspects differing allowed-VLAN lists", () => {
    const f = run(TS, sws({ trunk: trunk("1", "10,20") }, { trunk: trunk("1", "10") })).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "trunk-allowed-mismatch", status: "suspected", severity: "info" });
  });
  it("treats empty trunk output as 'no trunks', not as a command that did not run", () => {
    expect(kinds(run(TS, sws({ trunk: "" , vlan: access("10") }, { vlan: access("20") })).findings)).toEqual(["vlan-mismatch"]);
    const refused = (s: DeviceSnapshot) => ({ ...s, commands: { ...s.commands, [CMD.trunk]: { ok: true, text: "% Invalid input detected at '^' marker." } } });
    expect(run(TS, sws({ vlan: access("10") }, { vlan: access("20") }).map(refused)).findings).toEqual([]);
  });
  it("is silent for matching trunks and matching access ports", () => {
    expect(run(TS, sws({ trunk: trunk("99") }, { trunk: trunk("99") })).findings).toEqual([]);
    expect(run(TS, sws({ vlan: access("10") }, { vlan: access("10") })).findings).toEqual([]);
  });
  it("reports etherchannel problems from the flags", () => {
    const ec = "Group  Port-channel  Protocol    Ports\n------+-------------+-----------+------\n1      Po1(SD)         LACP      Gi0/0(D)    Gi0/1(s)\n2      Po2(SU)         LACP      Gi0/2(P)    Gi0/3(I)\n";
    const f = run(TS, [snap(S1, { etherchannel: ec })]).findings;
    expect(kinds(f)).toEqual(["etherchannel-down", "etherchannel-member", "etherchannel-member", "etherchannel-member"]);
    expect(f.find((x) => x.kind === "etherchannel-down")).toMatchObject({ interface: "Port-channel1", severity: "critical" });
  });
});

describe("connectivity and consistency", () => {
  const ping = (rate: number | null, out = `Success rate is ${rate} percent (0/5)`): PingResult => ({ fromId: "n1", from: "R1", to: "R2", toIp: "10.0.12.2", linkId: "l1", successRate: rate, sent: 5, output: out });
  it("turns a failed ping between up/up neighbours into a confirmed critical finding", () => {
    const f = run(T2, pair(), [ping(0)]).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "ping-failed", severity: "critical", status: "confirmed", device: "R1" });
    expect(f[0].evidence[0]).toContain("R1# ping 10.0.12.2: Success rate is 0 percent");
  });
  it("reports partial loss as a warning, and nothing for 100 percent", () => {
    expect(run(T2, pair(), [ping(60)]).findings[0]).toMatchObject({ kind: "ping-loss", severity: "warning" });
    expect(run(T2, pair(), [ping(100)]).findings).toEqual([]);
  });
  it("admits when a ping result could not be read", () => {
    expect(run(T2, pair(), [ping(null, "garbled")]).findings[0]).toMatchObject({ kind: "ping-unreadable", status: "suspected", severity: "info" });
  });
  it("finds a duplicate IP, confirmed only when both interfaces are live", () => {
    const dup = pair({ r2: { brief: upBrief("10.0.12.1") } });
    expect(run(T2, dup).findings.find((f) => f.kind === "duplicate-ip")).toMatchObject({ status: "confirmed", severity: "critical", title: "Duplicate IP address 10.0.12.1" });
    const shut = pair({ r2: { brief: brief([[G0, "10.0.12.1", "administratively down", "down"]]) } });
    expect(run(T2, shut).findings.find((f) => f.kind === "duplicate-ip")).toMatchObject({ status: "suspected", severity: "warning" });
  });
  it("finds duplicate router IDs, whether set explicitly or derived", () => {
    const explicit = pair({ ospf2: OSPF_ROUTER() });
    expect(run(T2, explicit).findings.find((f) => f.kind === "duplicate-router-id")?.title).toBe("Duplicate OSPF router ID 1.1.1.1");
    const same = (id: string) => ({ ospf1: `router ospf 1\n network 10.0.12.0 0.0.0.3 area 0\n`.replace("\n", `\n`), ospf2: `router ospf 1\n router-id ${id}\n network 10.0.12.0 0.0.0.3 area 0\n` });
    expect(run(T2, pair(same("10.0.12.1"))).findings.find((f) => f.kind === "duplicate-router-id")?.evidence.join()).toMatch(/derived 10\.0\.12\.1/);
  });
  it("reports a mask mismatch and, separately, different subnets", () => {
    expect(run(T2, pair({ ifc2: { name: G0, ip: "10.0.12.2", mask: "255.255.255.248" } })).findings.find((f) => f.kind === "mask-mismatch")).toMatchObject({ status: "confirmed" });
    expect(run(T2, pair({ ifc2: { name: G0, ip: "10.0.99.2" } })).findings.find((f) => f.kind === "subnet-mismatch")).toMatchObject({ status: "suspected" });
  });
  it("keeps finding ids stable between runs and distinct between findings", () => {
    const a = run(T2, pair({ r2: { brief: brief([[G0, "10.0.12.2", "administratively down", "down"]]) } })).findings;
    const b = run(T2, pair({ r2: { brief: brief([[G0, "10.0.12.2", "administratively down", "down"]]) } })).findings;
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
  });
  it("never reports a device that was not inspected", () => {
    expect(run(T2, [pair()[0]]).findings).toEqual([]);
  });
  it("sorts critical before warning before info", () => {
    const f = run(T2, pair({ r1: { brief: brief([[G0, "unassigned", "up", "up"]]) } }), [ping(0)]).findings;
    expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort((a, b) => ["critical", "warning", "info"].indexOf(a) - ["critical", "warning", "info"].indexOf(b)));
  });
});

describe("link colours from a run", () => {
  const summary = (analysis: ReturnType<typeof run>, pings: RunSummary["pings"] = []): RunSummary => ({ id: "r", labId: "L", startedAt: "", finishedAt: "", devices: [], interfaces: analysis.interfaces, pings, notRun: [] });
  const derive = (analysis: ReturnType<typeof run>, pings: RunSummary["pings"] = []) => deriveFromRun(T2, summary(analysis, pings), analysis.findings);

  it("shows operational only when both ends reported up/up, and says so", () => {
    const a = run(T2, pair());
    const d = derive(a, [{ linkId: "l1", ok: true, successRate: 100 }]);
    expect(d.links.l1.status).toBe("operational");
    expect(d.links.l1.text).toMatch(/Both ends report up\/up; ping between them succeeded/);
    expect(d.nodeFaults).toEqual({});
  });
  it("shows admin down, down and fault with the right precedence", () => {
    expect(derive(run(T2, pair({ r2: { brief: brief([[G0, "10.0.12.2", "administratively down", "down"]]) } }))).links.l1.status).toBe("admin_down");
    expect(derive(run(T2, pair({ r1: { brief: brief([[G0, "10.0.12.1", "up", "down"]]) } }))).links.l1.status).toBe("down");
    const missing = run(T2, pair({ r1: { ospf: OSPF_HEAD }, r2: { ospf: OSPF_HEAD }, ifc2: { name: G0, ip: "10.0.12.2", area: "1" } }));
    const d = derive(missing);
    expect(d.links.l1).toEqual({ status: "fault", text: "OSPF adjacency missing" });
    expect(d.nodeFaults).toEqual({ n1: "error" });
  });
  it("treats a failed ping as a fault even when both ends report up/up", () => {
    const a = run(T2, pair());
    expect(derive(a, [{ linkId: "l1", ok: false, successRate: 0 }]).links.l1.status).toBe("fault");
  });
  it("leaves a link alone when neither end was observed, and calls a half-seen link not inspected", () => {
    expect(derive(run(T2, [])).links).toEqual({});
    expect(derive(run(T2, [pair()[0]])).links.l1.status).toBe("not_inspected");
  });
  it("derives nothing without a run", () => {
    expect(deriveFromRun(T2, null, [])).toEqual({ links: {}, nodeFaults: {} });
  });
  it("flags only the devices that have findings, and suspected critical issues only as warnings", () => {
    const f = run(T2, pair({ r1: { ospf: OSPF_HEAD }, r2: { ospf: OSPF_HEAD } }));
    expect(f.findings[0].status).toBe("suspected");
    expect(derive(f).nodeFaults).toEqual({ n1: "warning" });
  });
});
