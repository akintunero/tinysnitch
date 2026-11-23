/**
 * Deterministic checks. Every finding is built from device output that is quoted as evidence. "confirmed" means
 * the output shows the problem; "suspected" means it is consistent with one but needs a follow-up command, which
 * the finding names. Nothing here calls a model.
 */
import { createHash } from "node:crypto";
import type { TopoLink, TopoNode, Topology } from "../cml/topology";
import { CMD } from "./commands";
import { type BgpPeer, type DeviceCfg, type EtherChannel, type IfBriefRow, type OspfNeighbor, type TrunkPort, normIf, ospfFor } from "./parsers";
import { driverFor } from "./platforms";
import type { DeviceSnapshot, Finding, IfaceObservation, PingResult, Severity } from "./types";

export type Analysis = { findings: Finding[]; interfaces: Record<string, Record<string, IfaceObservation>> };

type Dev = {
  node: TopoNode;
  brief: Map<string, IfBriefRow> | null;
  cfg: DeviceCfg | null;
  ospf: OspfNeighbor[] | null;
  bgp: BgpPeer[] | null;
  vlans: Map<string, string> | null;
  trunks: Map<string, TrunkPort> | null;
  channels: EtherChannel[] | null;
  raw: DeviceSnapshot["commands"];
};

const REFUSED = /^\s*%|^\s*error:|syntax error|invalid input|incomplete command|unknown command|not supported/i;
const usable = (snap: DeviceSnapshot, key: keyof typeof CMD): string | null => {
  const r = snap.commands[CMD[key]];
  return r && r.ok && r.text.trim() && !REFUSED.test(r.text.split(/\r?\n/).find((l) => l.trim()) ?? "") ? r.text : null;
};

/**
 * The output of a command that ran and was accepted, which may legitimately be empty: `show interfaces trunk`
 * prints nothing when there are no trunks, and an empty OSPF table means "no neighbours". null means the command
 * failed or was refused, so nothing may be concluded from it.
 */
function ran(snap: DeviceSnapshot, key: keyof typeof CMD): string | null {
  const r = snap.commands[CMD[key]];
  if (!r || !r.ok) return null;
  return REFUSED.test(r.text.split(/\r?\n/).find((l) => l.trim()) ?? "") ? null : r.text;
}

function build(node: TopoNode, snap: DeviceSnapshot): Dev {
  const drv = driverFor(node.platform) ?? driverFor("ios")!;
  const t = (k: keyof typeof CMD) => usable(snap, k);
  const brief = t("brief"), cfg = t("config"), bgp = t("bgp");
  const ospf = ran(snap, "ospf"), vlan = ran(snap, "vlan"), trunk = ran(snap, "trunk"), ec = ran(snap, "etherchannel");
  return {
    node, raw: snap.commands,
    brief: brief ? new Map(drv.parse.brief(brief).map((r) => [r.name, r])) : null,
    cfg: cfg ? drv.parse.config(cfg) : null,
    ospf: ospf !== null ? drv.parse.ospf(ospf) : null,
    bgp: bgp ? drv.parse.bgp(bgp) : null,
    vlans: vlan !== null && drv.parse.vlan ? drv.parse.vlan(vlan) : null,
    trunks: trunk !== null && drv.parse.trunk ? new Map(drv.parse.trunk(trunk).map((p) => [p.port, p])) : null,
    channels: ec !== null && drv.parse.etherchannel ? drv.parse.etherchannel(ec) : null,
  };
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
/** Evidence names the command the device really ran, which on a non-IOS platform differs from the logical key. */
const ev = (d: Dev, cmd: string, line: string) => `${d.node.label}# ${d.raw[cmd]?.command ?? cmd}: ${line.trim()}`;
const briefLine = (d: Dev, r: IfBriefRow) => ev(d, CMD.brief, `${r.name} ${r.ip ?? "unassigned"} ${r.status}/${r.protocol}`);

function mk(f: Omit<Finding, "id">): Finding {
  const key = [f.kind, f.deviceId, f.interface ?? "", f.peer?.deviceId ?? "", f.peer?.interface ?? "", f.kind === "duplicate-ip" || f.kind === "duplicate-router-id" ? f.title : ""].join("|");
  return { id: createHash("sha1").update(key).digest("hex").slice(0, 12), ...f };
}

export function analyse(topology: Topology, snapshots: Map<string, DeviceSnapshot>, pings: PingResult[]): Analysis {
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const devs = new Map<string, Dev>();
  for (const [id, snap] of snapshots) { const n = nodes.get(id); if (n) devs.set(id, build(n, snap)); }
  const findings: Finding[] = [];
  const interfaces: Analysis["interfaces"] = {};
  for (const d of devs.values()) {
    if (!d.brief) continue;
    interfaces[d.node.id] = Object.fromEntries([...d.brief.values()].map((r) => [r.name, { status: r.status, protocol: r.protocol, ip: r.ip }]));
  }

  /** Both ends of a link as {dev, iface}, with the peer, if the device was inspected. */
  const ends = (l: TopoLink) => [
    { d: devs.get(l.source), node: nodes.get(l.source)!, iface: normIf(l.sourceInterface), p: devs.get(l.target), pNode: nodes.get(l.target)!, pIface: normIf(l.targetInterface) },
    { d: devs.get(l.target), node: nodes.get(l.target)!, iface: normIf(l.targetInterface), p: devs.get(l.source), pNode: nodes.get(l.source)!, pIface: normIf(l.sourceInterface) },
  ];
  const peerRef = (e: ReturnType<typeof ends>[number]) => ({ device: e.pNode.label, deviceId: e.pNode.id, interface: e.pIface });

  // ---- interfaces ----------------------------------------------------------------------------------------
  for (const l of topology.links) {
    for (const e of ends(l)) {
      const d = e.d;
      const o = d?.brief?.get(e.iface);
      if (!d || !o) continue;
      const po = e.p?.brief?.get(e.pIface);
      const base = { device: d.node.label, deviceId: d.node.id, interface: e.iface, peer: peerRef(e), linkId: l.id };
      if (o.status === "administratively down") {
        if (po && po.status !== "administratively down") {
          findings.push(mk({ ...base, kind: "interface-admin-down", severity: "warning", status: "confirmed", title: "Interface administratively down",
            description: `${e.iface} on ${d.node.label} is shut down, but the interface it connects to (${e.pNode.label} ${e.pIface}) is not.`,
            evidence: [briefLine(d, o), ...(e.p ? [briefLine(e.p, po)] : [])], probableCause: "Someone ran shutdown on this interface, or it was never enabled.",
            recommendedAction: `If the link should carry traffic, enable ${e.iface} on ${d.node.label} (no shutdown) after review.`, verification: `Confirmed from ${CMD.brief} on ${d.node.label}.` }));
        }
      } else if (o.status === "down" || o.protocol === "down") {
        const peerShut = po?.status === "administratively down";
        const peerOff = e.pNode.state !== "BOOTED";
        findings.push(mk({ ...base, kind: "interface-down", severity: "critical", status: "confirmed",
          title: o.status === "down" ? "Interface down" : "Line protocol down",
          description: `${e.iface} on ${d.node.label} reports ${o.status}/${o.protocol}.`, evidence: [briefLine(d, o), ...(e.p && po ? [briefLine(e.p, po)] : [])],
          probableCause: peerShut ? `The peer interface ${e.pNode.label} ${e.pIface} is administratively down.` : peerOff ? `The peer device ${e.pNode.label} is not running.` : o.status === "up" ? "The line protocol is down: an encapsulation or keepalive mismatch, or the peer is not responding." : "No signal from the other end of the link.",
          recommendedAction: peerShut ? `Enable ${e.pIface} on ${e.pNode.label} if the link should be up.` : `Check ${e.pNode.label} ${e.pIface} and the link state in CML.`, verification: `Confirmed from ${CMD.brief} on ${d.node.label}.` }));
      } else if (d.node.kind === "router" && o.ip === null && o.status === "up" && o.protocol === "up") {
        findings.push(mk({ ...base, kind: "no-ip", severity: "warning", status: "suspected", title: "Connected interface has no IP address",
          description: `${e.iface} on ${d.node.label} is up/up and cabled to ${e.pNode.label} but has no IP address.`, evidence: [briefLine(d, o)],
          probableCause: "The interface was never addressed. It may be intentional (a layer 2 or unnumbered use).", recommendedAction: `If this is a routed link, assign an address to ${e.iface}.`,
          verification: `Check ${CMD.config} on ${d.node.label} for 'ip unnumbered' or switchport commands.` }));
      }
    }
  }

  // ---- OSPF ----------------------------------------------------------------------------------------------
  const l3 = (n: TopoNode) => n.kind === "router" || n.kind === "l3switch";
  for (const l of topology.links) {
    const [a, b] = ends(l);
    if (!a.d?.cfg || !b.d?.cfg || !a.d.ospf || !b.d.ospf || !l3(a.node) || !l3(b.node)) continue;
    const ca = a.d.cfg.interfaces.get(a.iface), cb = b.d.cfg.interfaces.get(b.iface);
    const oa = a.d.brief?.get(a.iface), ob = b.d.brief?.get(b.iface);
    if (!ca || !cb || !oa || !ob) continue;
    if (!(oa.status === "up" && oa.protocol === "up" && ob.status === "up" && ob.protocol === "up")) continue; // the interface findings cover it
    const fa = ospfFor(a.d.cfg, ca), fb = ospfFor(b.d.cfg, cb);
    if (!fa && !fb) continue;
    const na = a.d.ospf.filter((n) => n.interface === a.iface), nb = b.d.ospf.filter((n) => n.interface === b.iface);
    const base = { device: a.node.label, deviceId: a.node.id, interface: a.iface, peer: peerRef(a), linkId: l.id };
    const nbrEv = [...na.map((n) => ev(a.d!, CMD.ospf, `${n.neighborId} ${n.state} ${n.interface}`)), ...nb.map((n) => ev(b.d!, CMD.ospf, `${n.neighborId} ${n.state} ${n.interface}`))];
    const stuck = [...na, ...nb].find((n) => !(n.state === "FULL" || (n.state === "2WAY" && n.role === "DROTHER")));

    if (stuck) {
      const mtuA = ca.mtu ?? 1500, mtuB = cb.mtu ?? 1500;
      const mtu = (stuck.state === "EXSTART" || stuck.state === "EXCHANGE") && mtuA !== mtuB;
      findings.push(mk({ ...base, kind: "ospf-not-full", severity: mtu ? "warning" : "critical", status: mtu ? "confirmed" : "suspected", title: "OSPF neighbour not FULL",
        description: `The OSPF neighbour on the ${a.node.label} ${a.iface} to ${b.node.label} ${b.iface} link is ${stuck.state}.`,
        evidence: [...nbrEv, ...(mtu ? [ev(a.d, CMD.config, `${a.iface} mtu ${mtuA}`), ev(b.d, CMD.config, `${b.iface} mtu ${mtuB}`)] : [])],
        probableCause: mtu ? `MTU mismatch: ${mtuA} on ${a.node.label} versus ${mtuB} on ${b.node.label}. An adjacency sticks in EXSTART when MTUs differ.` : `Stuck in ${stuck.state}. Common causes are an MTU mismatch, authentication mismatch or an unreachable neighbour.`,
        recommendedAction: mtu ? `Set the same MTU on both interfaces.` : `Compare 'show ip ospf interface' and the MTU on both ends.`, verification: mtu ? `Confirmed from ${CMD.ospf} and ${CMD.config} on both devices.` : `Suspected: run 'show ip ospf interface ${a.iface}' on ${a.node.label} to settle it.` }));
      continue;
    }
    if (na.length || nb.length) continue; // FULL: healthy

    let cause: string | null = null;
    const cfgEv: string[] = [];
    if (!fa || !fb) {
      const off = !fa ? a : b;
      cause = `OSPF is not enabled on ${off.node.label} ${off.iface}.`;
      cfgEv.push(ev(off.d!, CMD.config, `${off.iface} is not covered by any OSPF network statement or ip ospf command`));
    } else if (fa.passive || fb.passive) {
      const p = fa.passive ? a : b;
      cause = `${p.iface} on ${p.node.label} is a passive interface, so it sends no OSPF hellos.`;
      cfgEv.push(ev(p.d!, CMD.config, `passive-interface covers ${p.iface}`));
    } else if (ca.plen !== null && cb.plen !== null && ca.plen !== cb.plen) {
      cause = `Subnet mask mismatch: /${ca.plen} on ${a.node.label} versus /${cb.plen} on ${b.node.label}.`;
      cfgEv.push(ev(a.d, CMD.config, `${a.iface} ip ${ca.ip}/${ca.plen}`), ev(b.d, CMD.config, `${b.iface} ip ${cb.ip}/${cb.plen}`));
    } else if (fa.area !== fb.area) {
      cause = `OSPF area mismatch: area ${fa.area} on ${a.node.label} versus area ${fb.area} on ${b.node.label}.`;
      cfgEv.push(ev(a.d, CMD.config, `${a.iface} in area ${fa.area}`), ev(b.d, CMD.config, `${b.iface} in area ${fb.area}`));
    }
    findings.push(mk({ ...base, kind: "ospf-adjacency-missing", severity: "critical", status: cause ? "confirmed" : "suspected", title: "OSPF adjacency missing",
      description: `Both ends of the ${a.node.label} ${a.iface} to ${b.node.label} ${b.iface} link are up and run OSPF, yet neither lists the other as a neighbour.`,
      evidence: [briefLine(a.d, oa), briefLine(b.d, ob), ev(a.d, CMD.ospf, "no neighbour on " + a.iface), ev(b.d, CMD.ospf, "no neighbour on " + b.iface), ...cfgEv],
      probableCause: cause ?? "The configuration does not explain it. Hello or dead timer, authentication or network type mismatches are common.",
      recommendedAction: cause ? "Correct the mismatch on the affected interface after review." : `Compare 'show ip ospf interface ${a.iface}' on both devices.`,
      verification: cause ? `Confirmed: no neighbour in ${CMD.ospf} on either end, and the cause is visible in ${CMD.config}.` : `Suspected: run 'show ip ospf interface ${a.iface}' on ${a.node.label}.` }));
  }

  // ---- BGP -----------------------------------------------------------------------------------------------
  const ipOwner = new Map<string, { d: Dev; r: IfBriefRow }>();
  for (const d of devs.values()) for (const r of d.brief?.values() ?? []) if (r.ip) ipOwner.set(r.ip, { d, r });
  for (const d of devs.values()) {
    for (const p of d.bgp ?? []) {
      if (p.state === "Established") continue;
      const owner = ipOwner.get(p.neighbor);
      const shut = d.cfg?.bgp?.neighbors.find((n) => n.ip === p.neighbor)?.shutdown;
      const lines = [ev(d, CMD.bgp, p.raw), ...(owner ? [`${owner.d.node.label}# ${CMD.brief}: ${owner.r.name} ${owner.r.ip} ${owner.r.status}/${owner.r.protocol}`] : [])];
      const cause = shut || /admin/i.test(p.state) ? "The neighbour is administratively shut down on this device." : owner && owner.r.status !== "up" ? `${p.neighbor} is ${owner.d.node.label} ${owner.r.name}, which is ${owner.r.status}/${owner.r.protocol}.` : /idle/i.test(p.state) ? "The session is idle: the peer is unreachable, or the neighbour is misconfigured." : "The TCP session to the peer is not completing: reachability, an ACL, the update source or the peer's remote-as.";
      findings.push(mk({ kind: "bgp-peer-down", severity: "critical", status: "confirmed", device: d.node.label, deviceId: d.node.id, interface: null, peer: owner ? { device: owner.d.node.label, deviceId: owner.d.node.id, interface: owner.r.name } : null, linkId: null,
        title: "BGP peer not established", description: `The BGP session with ${p.neighbor} (AS ${p.as}) on ${d.node.label} is ${p.state}.`, evidence: lines, probableCause: cause,
        recommendedAction: `Check reachability to ${p.neighbor} and the neighbor configuration on both sides.`, verification: `Confirmed from ${CMD.bgp} on ${d.node.label}.` }));
    }
  }

  // ---- switching -----------------------------------------------------------------------------------------
  const sw = (n: TopoNode) => n.kind === "l2switch" || n.kind === "l3switch";
  const portMode = (d: Dev, iface: string) => {
    const t = d.trunks?.get(iface);
    if (t && /trunking/i.test(t.status)) return { mode: "trunk" as const, native: t.native, allowed: t.allowed, line: ev(d, CMD.trunk, `${iface} ${t.mode} ${t.encapsulation} ${t.status} native ${t.native}`) };
    const v = d.vlans?.get(iface);
    if (v) return { mode: "access" as const, vlan: v, line: ev(d, CMD.vlan, `${iface} in VLAN ${v}`) };
    return null;
  };
  for (const l of topology.links) {
    const [a, b] = ends(l);
    if (!a.d || !b.d || !sw(a.node) || !sw(b.node) || !a.d.trunks || !b.d.trunks) continue;
    const ma = portMode(a.d, a.iface), mb = portMode(b.d, b.iface);
    if (!ma || !mb) continue;
    const base = { device: a.node.label, deviceId: a.node.id, interface: a.iface, peer: peerRef(a), linkId: l.id };
    const lines = [ma.line, mb.line];
    const where = `${a.node.label} ${a.iface} and ${b.node.label} ${b.iface}`;
    if (ma.mode !== mb.mode) {
      findings.push(mk({ ...base, kind: "trunk-access-mismatch", severity: "warning", status: "confirmed", title: "Trunk and access port on one link", description: `${where} are cabled together but one is a trunk and the other an access port.`, evidence: lines,
        probableCause: "One end was configured as a trunk and the other as an access port.", recommendedAction: "Configure both ends the same way.", verification: `Confirmed from ${CMD.trunk} and ${CMD.vlan} on both switches.` }));
    } else if (ma.mode === "access" && mb.mode === "access" && ma.vlan !== mb.vlan) {
      findings.push(mk({ ...base, kind: "vlan-mismatch", severity: "warning", status: "confirmed", title: "VLAN mismatch across link", description: `${where} are in different VLANs (${ma.vlan} and ${mb.vlan}).`, evidence: lines,
        probableCause: "The access ports were assigned to different VLANs.", recommendedAction: "Put both ports in the intended VLAN.", verification: `Confirmed from ${CMD.vlan} on both switches.` }));
    } else if (ma.mode === "trunk" && mb.mode === "trunk") {
      if (ma.native !== mb.native) {
        findings.push(mk({ ...base, kind: "native-vlan-mismatch", severity: "warning", status: "confirmed", title: "Native VLAN mismatch", description: `The trunk between ${where} uses native VLAN ${ma.native} on one end and ${mb.native} on the other.`, evidence: lines,
          probableCause: "The native VLAN differs between the two ends, which leaks traffic between VLANs.", recommendedAction: "Set the same native VLAN on both ends.", verification: `Confirmed from ${CMD.trunk} on both switches.` }));
      }
      if ((ma.allowed ?? "") !== (mb.allowed ?? "")) {
        findings.push(mk({ ...base, kind: "trunk-allowed-mismatch", severity: "info", status: "suspected", title: "Trunk allowed-VLAN lists differ", description: `The allowed VLANs on the ${where} trunk differ (${ma.allowed} versus ${mb.allowed}).`, evidence: lines,
          probableCause: "Different 'switchport trunk allowed vlan' lists. This is sometimes deliberate pruning.", recommendedAction: "Confirm the difference is intended.", verification: `Suspected: compare ${CMD.trunk} on both switches against the VLAN plan.` }));
      }
    }
  }
  for (const d of devs.values()) {
    for (const ch of d.channels ?? []) {
      const lineBase = `${ch.portChannel}(${ch.flags}) ${ch.members.map((m) => `${m.port}(${m.flag})`).join(" ")}`;
      const base = { device: d.node.label, deviceId: d.node.id, peer: null, linkId: null };
      if (/D/.test(ch.flags)) {
        findings.push(mk({ ...base, interface: ch.portChannel, kind: "etherchannel-down", severity: "critical", status: "confirmed", title: "EtherChannel down", description: `${ch.portChannel} on ${d.node.label} is down (flags ${ch.flags}).`, evidence: [ev(d, CMD.etherchannel, lineBase)],
          probableCause: "No member port is bundled.", recommendedAction: "Check the member ports and the channel mode on both ends.", verification: `Confirmed from ${CMD.etherchannel} on ${d.node.label}.` }));
      }
      for (const m of ch.members.filter((x) => !/^[PH]$/i.test(x.flag))) {
        findings.push(mk({ ...base, interface: m.port, kind: "etherchannel-member", severity: "warning", status: "confirmed", title: "EtherChannel member not bundled", description: `${m.port} in ${ch.portChannel} on ${d.node.label} has flag (${m.flag}) instead of (P).`, evidence: [ev(d, CMD.etherchannel, lineBase)],
          probableCause: m.flag === "s" ? "The member is suspended: its settings or the partner's do not match the channel." : m.flag === "I" ? "The port is standalone: the partner is not running the channel." : `Flag (${m.flag}) means the port is not part of the bundle.`, recommendedAction: "Make the channel mode and settings match on both ends.", verification: `Confirmed from ${CMD.etherchannel} on ${d.node.label}.` }));
      }
    }
  }

  // ---- connectivity --------------------------------------------------------------------------------------
  for (const p of pings) {
    const from = nodes.get(p.fromId);
    const d = devs.get(p.fromId);
    if (!from || !d) continue;
    const l = topology.links.find((x) => x.id === p.linkId);
    const peerId = l ? (l.source === p.fromId ? l.target : l.source) : null;
    const peerNode = peerId ? nodes.get(peerId) : undefined;
    const ifc = l ? normIf(l.source === p.fromId ? l.sourceInterface : l.targetInterface) : null;
    const base = { device: from.label, deviceId: from.id, interface: ifc, peer: peerNode && l ? { device: peerNode.label, deviceId: peerNode.id, interface: normIf(l.source === p.fromId ? l.targetInterface : l.sourceInterface) } : null, linkId: p.linkId };
    const line = ev(d, `ping ${p.toIp}`, p.output.split(/\r?\n/).find((x) => /Success rate/i.test(x)) ?? p.error ?? "no result");
    if (p.successRate === null) {
      findings.push(mk({ ...base, kind: "ping-unreadable", severity: "info", status: "suspected", title: "Ping result could not be read", description: `The ping from ${from.label} to ${p.toIp} returned output Tiny Snitch could not interpret.`, evidence: [line],
        probableCause: p.error ?? "Unexpected output format.", recommendedAction: `Run 'ping ${p.toIp}' on ${from.label} by hand.`, verification: "Suspected: the result was not readable." }));
    } else if (p.successRate === 0) {
      findings.push(mk({ ...base, kind: "ping-failed", severity: "critical", status: "confirmed", title: "Ping to directly connected peer failed", description: `${from.label} cannot reach ${p.toIp}, the address on the other end of its link, although both interfaces report up/up.`, evidence: [line],
        probableCause: "Layer 2 or addressing problem between two up interfaces: a wrong subnet, a mask mismatch, an ACL or a VLAN mismatch.", recommendedAction: "Compare the IP addresses and masks on both ends, and check for ACLs or VLAN differences.", verification: `Confirmed: ping ${p.toIp} from ${from.label} got no replies.` }));
    } else if (p.successRate < 100) {
      findings.push(mk({ ...base, kind: "ping-loss", severity: "warning", status: "confirmed", title: "Packet loss to directly connected peer", description: `${from.label} lost packets pinging ${p.toIp} (${p.successRate}% success).`, evidence: [line],
        probableCause: "Intermittent loss: congestion, a flapping link or a duplex or MTU problem.", recommendedAction: "Repeat the test and inspect interface counters.", verification: `Confirmed: ${p.successRate}% success from ${from.label}.` }));
    }
  }

  // ---- configuration consistency -------------------------------------------------------------------------
  const byIp = new Map<string, { d: Dev; r: IfBriefRow }[]>();
  for (const d of devs.values()) for (const r of d.brief?.values() ?? []) if (r.ip && r.status !== "deleted") byIp.set(r.ip, [...(byIp.get(r.ip) ?? []), { d, r }]);
  for (const [ip, owners] of byIp) {
    if (owners.length < 2) continue;
    const live = owners.filter((o) => o.r.status !== "administratively down");
    const first = owners[0];
    findings.push(mk({ kind: "duplicate-ip", severity: live.length > 1 ? "critical" : "warning", status: live.length > 1 ? "confirmed" : "suspected", device: first.d.node.label, deviceId: first.d.node.id, interface: first.r.name, peer: null, linkId: null,
      title: `Duplicate IP address ${ip}`, description: `${ip} is configured on ${owners.map((o) => `${o.d.node.label} ${o.r.name}`).join(" and ")}.`, evidence: owners.map((o) => briefLine(o.d, o.r)),
      probableCause: live.length > 1 ? "The same address was assigned twice." : "The duplicate sits on a shut-down interface, so it is not active yet.", recommendedAction: "Give each interface its own address.", verification: `${live.length > 1 ? "Confirmed" : "Suspected"} from ${CMD.brief} on each device.` }));
  }
  const rid = (d: Dev): string | null => {
    if (!d.cfg?.ospf) return null;
    if (d.cfg.ospf.routerId) return d.cfg.ospf.routerId;
    const rows = [...(d.brief?.values() ?? [])].filter((r) => r.ip && r.status === "up");
    const pick = (list: IfBriefRow[]) => list.map((r) => r.ip!).sort((x, y) => x.split(".").reduce((n, o) => n * 256 + +o, 0) - y.split(".").reduce((n, o) => n * 256 + +o, 0)).at(-1) ?? null;
    return pick(rows.filter((r) => r.name.startsWith("Loopback"))) ?? pick(rows);
  };
  const byRid = new Map<string, Dev[]>();
  for (const d of devs.values()) { const r = rid(d); if (r) byRid.set(r, [...(byRid.get(r) ?? []), d]); }
  for (const [id, group] of byRid) {
    if (group.length < 2) continue;
    findings.push(mk({ kind: "duplicate-router-id", severity: "critical", status: "confirmed", device: group[0].node.label, deviceId: group[0].node.id, interface: null, peer: null, linkId: null, title: `Duplicate OSPF router ID ${id}`,
      description: `${group.map((g) => g.node.label).join(" and ")} use the same OSPF router ID, ${id}.`, evidence: group.map((g) => ev(g, CMD.config, g.cfg?.ospf?.routerId ? `router-id ${id}` : `no router-id set; derived ${id} from an interface address`)),
      probableCause: "A router ID was copied between devices, or two devices share the same highest interface address.", recommendedAction: "Set a unique router-id on each router.", verification: `Confirmed from ${CMD.config} on each device.` }));
  }
  for (const l of topology.links) {
    const [a, b] = ends(l);
    const ca = a.d?.cfg?.interfaces.get(a.iface), cb = b.d?.cfg?.interfaces.get(b.iface);
    if (!a.d || !b.d || !ca?.ip || !cb?.ip || ca.plen === null || cb.plen === null) continue;
    const base = { device: a.node.label, deviceId: a.node.id, interface: a.iface, peer: peerRef(a), linkId: l.id };
    const lines = [ev(a.d, CMD.config, `${a.iface} ip ${ca.ip}/${ca.plen}`), ev(b.d, CMD.config, `${b.iface} ip ${cb.ip}/${cb.plen}`)];
    if (ca.plen !== cb.plen) {
      findings.push(mk({ ...base, kind: "mask-mismatch", severity: "warning", status: "confirmed", title: "Subnet mask mismatch", description: `The two ends of the ${a.node.label} ${a.iface} to ${b.node.label} ${b.iface} link use different masks (/${ca.plen} and /${cb.plen}).`, evidence: lines,
        probableCause: "One end was addressed with a different prefix length.", recommendedAction: "Use the same prefix length on both ends.", verification: `Confirmed from ${CMD.config} on both devices.` }));
    } else {
      const net = (ip: string, n: number) => ((ip.split(".").reduce((x, o) => x * 256 + +o, 0) >>> (32 - n)) << 0);
      if (net(ca.ip, ca.plen) !== net(cb.ip, cb.plen)) {
        findings.push(mk({ ...base, kind: "subnet-mismatch", severity: "warning", status: "suspected", title: "Link ends are in different subnets", description: `${ca.ip}/${ca.plen} and ${cb.ip}/${cb.plen} are in different subnets, though the interfaces are cabled together.`, evidence: lines,
          probableCause: "An addressing mistake, or the link is deliberately unnumbered or uses secondary addresses.", recommendedAction: "Check the addressing plan for this link.", verification: `Suspected: compare the addressing plan with ${CMD.config}.` }));
      }
    }
  }

  const seen = new Set<string>();
  const unique = findings.filter((f) => !seen.has(f.id) && seen.add(f.id));
  unique.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.device.localeCompare(y.device) || x.title.localeCompare(y.title));
  return { findings: unique, interfaces };
}
