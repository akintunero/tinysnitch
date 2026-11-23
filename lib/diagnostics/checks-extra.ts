/**
 * Further deterministic checks for IOS / IOS-XE: spanning-tree state, static-route next hops, ACL problems and a small
 * security baseline. Every finding quotes the device output it rests on. A check that needs output the device did not
 * give (a failed command, an empty reply) produces nothing, never a guess.
 */
import type { TopoLink, TopoNode } from "../cml/topology";
import { type DeviceCfg, type IfBriefRow, normIf, parseBgpSummary } from "./parsers";
import { bgpPolicyFindings } from "./checks-bgp";
import type { Finding, Fix } from "./types";

export type MakeFinding = (f: Omit<Finding, "id">) => Finding;

export type ExtraInput = {
  node: TopoNode;
  /** `show running-config` output, when the command ran and was accepted. */
  configText: string | null;
  cfg: DeviceCfg | null;
  brief: Map<string, IfBriefRow> | null;
  /** `show spanning-tree` output, when the command ran and was accepted (may be empty on a router). */
  stpText: string | null;
  /** `show ip bgp summary` output, when BGP is running and the command was accepted. */
  bgpText?: string | null;
  /** `show isis neighbors` output, when IS-IS is configured and the command was accepted. */
  isisText?: string | null;
};

const ip4 = (s: string) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0) >>> 0;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ev = (label: string, cmd: string, line: string) => `${label}# ${cmd}: ${line.trim()}`;

// ---- IS-IS ---------------------------------------------------------------------------------------------------
export type IsisNeighbor = { systemId: string; type: string; interface: string; ip: string; state: string; raw: string };

/** Rows of `show isis neighbors`: system id, level, interface, address, state, holdtime, circuit id. */
export function parseIsisNeighbors(text: string): IsisNeighbor[] {
  const out: IsisNeighbor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(L1L2|L1|L2|\S+)\s+(\S+)\s+(\d+\.\d+\.\d+\.\d+|\S+)\s+(UP|INIT|DOWN|Up|Init|Down)\s+\d+/.exec(line.trim());
    if (m && /^(L1|L2|L1L2)$/.test(m[2])) out.push({ systemId: m[1], type: m[2], interface: normIf(m[3]), ip: m[4], state: m[5].toUpperCase(), raw: line.trim() });
  }
  return out;
}

/** The interfaces a configuration runs IS-IS on (`ip router isis`), with the circuit type each asks for. */
export function isisInterfaces(config: string): { name: string; circuit: string | null }[] {
  const out: { name: string; circuit: string | null }[] = [];
  let cur: { name: string; isis: boolean; circuit: string | null } | null = null;
  const flush = () => { if (cur?.isis) out.push({ name: cur.name, circuit: cur.circuit }); };
  for (const raw of config.split(/\r?\n/)) {
    const h = /^interface\s+(\S+)/.exec(raw);
    if (h) { flush(); cur = { name: normIf(h[1]), isis: false, circuit: null }; continue; }
    if (!cur) continue;
    if (/^\S/.test(raw)) { flush(); cur = null; continue; }
    if (/^\s+ip router isis(\s|$)/.test(raw)) cur.isis = true;
    const c = /^\s+isis circuit-type\s+(level-1-2|level-1|level-2-only)/.exec(raw);
    if (c) cur.circuit = c[1];
  }
  flush();
  return out;
}

const levelsOf = (c: string | null) => (c === "level-1" ? ["L1"] : c === "level-2-only" ? ["L2"] : ["L1", "L2"]);

// ---- spanning tree --------------------------------------------------------------------------------------------
export type StpPort = { name: string; role: string; state: string; inconsistent: string | null; raw: string };
export type StpVlan = { vlan: string; rootAddr: string | null; rootPriority: number | null; isRoot: boolean; bridgeAddr: string | null; ports: StpPort[] };

/** `show spanning-tree` as IOS prints it, one block per VLAN or MST instance. */
export function parseStp(text: string): StpVlan[] {
  const out: StpVlan[] = [];
  let cur: StpVlan | null = null;
  let section: "root" | "bridge" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(VLAN\d+|MST\d+)\s*$/i))) { cur = { vlan: m[1].toUpperCase(), rootAddr: null, rootPriority: null, isRoot: false, bridgeAddr: null, ports: [] }; out.push(cur); section = null; continue; }
    if (!cur) continue;
    if (/^\s*Root ID\b/i.test(line)) section = "root";
    else if (/^\s*Bridge ID\b/i.test(line)) section = "bridge";
    if (section === "root") {
      if ((m = line.match(/Priority\s+(\d+)/i)) && cur.rootPriority === null) cur.rootPriority = Number(m[1]);
      if ((m = line.match(/Address\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})/i)) && !cur.rootAddr) cur.rootAddr = m[1].toLowerCase();
      if (/This bridge is the root/i.test(line)) cur.isRoot = true;
    } else if (section === "bridge") {
      if ((m = line.match(/Address\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})/i)) && !cur.bridgeAddr) cur.bridgeAddr = m[1].toLowerCase();
    }
    if ((m = line.match(/^(\S+)\s+(Root|Desg|Altn|Back|Mstr|Dis)\s+([A-Z]{3}\*?)\s*(\d*)\s+(\d+\.\d+)\s+(\S+)\s*(.*)$/))) {
      const inc = `${m[3]} ${m[7]}`.match(/\*?(ROOT|LOOP|PVID|TYPE|BPDU|PORT)_Inc/i);
      cur.ports.push({ name: normIf(m[1]), role: m[2], state: m[3].replace("*", ""), inconsistent: inc ? inc[0].replace("*", "") : m[3].includes("*") ? "inconsistent" : null, raw: line.trim() });
    }
  }
  return out;
}

// ---- static routes -------------------------------------------------------------------------------------------
export type StaticRoute = { prefix: string; mask: string; nextHop: string | null; iface: string | null; raw: string };

export function parseStaticRoutes(config: string): StaticRoute[] {
  const out: StaticRoute[] = [];
  for (const raw of config.split(/\r?\n/)) {
    const m = raw.match(/^ip route (\d+\.\d+\.\d+\.\d+) (\d+\.\d+\.\d+\.\d+) (\S+)(?: (\S+))?/);
    if (!m) continue; // routes in a VRF ("ip route vrf X ...") are left alone
    const [, prefix, mask, a, b] = m;
    const nextHop = IPV4.test(a) ? a : b && IPV4.test(b) ? b : null;
    const iface = IPV4.test(a) ? null : a;
    out.push({ prefix, mask, nextHop, iface, raw: raw.trim() });
  }
  return out;
}

// ---- ACLs ---------------------------------------------------------------------------------------------------
type Addr = { addr: number; wild: number };
type PortSpec = { op: string; values: string[] };
export type Ace = { seq: number; action: "permit" | "deny"; proto: string; src: Addr; srcPort: PortSpec | null; dst: Addr; dstPort: PortSpec | null; extra: string; raw: string };
export type Acl = { name: string; kind: "standard" | "extended"; aces: Ace[] };

function addrSpec(t: string[], i: number): [Addr, number] | null {
  if (t[i] === "any") return [{ addr: 0, wild: 0xffffffff }, i + 1];
  if (t[i] === "host" && IPV4.test(t[i + 1] ?? "")) return [{ addr: ip4(t[i + 1]), wild: 0 }, i + 2];
  if (IPV4.test(t[i] ?? "")) return IPV4.test(t[i + 1] ?? "") ? [{ addr: ip4(t[i]), wild: ip4(t[i + 1]) }, i + 2] : [{ addr: ip4(t[i]), wild: 0 }, i + 1];
  return null;
}

function portSpec(t: string[], i: number): [PortSpec | null, number] {
  if (["eq", "neq", "gt", "lt"].includes(t[i]) && t[i + 1]) return [{ op: t[i], values: [t[i + 1]] }, i + 2];
  if (t[i] === "range" && t[i + 1] && t[i + 2]) return [{ op: "range", values: [t[i + 1], t[i + 2]] }, i + 3];
  return [null, i];
}

export function parseAce(text: string, kind: "standard" | "extended"): Ace | null {
  const t = text.trim().split(/\s+/);
  let seq = 0;
  if (/^\d+$/.test(t[0])) seq = Number(t.shift());
  const action = t.shift();
  if (action !== "permit" && action !== "deny") return null;
  if (kind === "standard") {
    const s = addrSpec(t, 0);
    return s ? { seq, action, proto: "ip", src: s[0], srcPort: null, dst: { addr: 0, wild: 0xffffffff }, dstPort: null, extra: t.slice(s[1]).join(" ").replace(/\blog(-input)?\b/g, "").trim(), raw: text.trim() } : null;
  }
  const proto = t.shift();
  if (!proto) return null;
  const s = addrSpec(t, 0);
  if (!s) return null;
  let i = s[1];
  let srcPort: PortSpec | null = null, dstPort: PortSpec | null = null;
  if (proto === "tcp" || proto === "udp") [srcPort, i] = portSpec(t, i);
  const d = addrSpec(t, i);
  if (!d) return null;
  i = d[1];
  if (proto === "tcp" || proto === "udp") [dstPort, i] = portSpec(t, i);
  return { seq, action, proto, src: s[0], srcPort, dst: d[0], dstPort, extra: t.slice(i).join(" ").replace(/\blog(-input)?\b/g, "").trim(), raw: text.trim() };
}

export type AclUse = { acl: string; iface: string; direction: string; raw: string };

export function parseAcls(config: string): { acls: Map<string, Acl>; uses: AclUse[] } {
  const acls = new Map<string, Acl>();
  const uses: AclUse[] = [];
  let current: Acl | null = null;
  let iface: string | null = null;
  const numberedKind = (n: number): "standard" | "extended" => ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999) ? "standard" : "extended");
  for (const raw of config.split(/\r?\n/)) {
    let m: RegExpMatchArray | null;
    if (!/^\s/.test(raw)) {
      current = null;
      iface = null;
      if ((m = raw.match(/^ip access-list (standard|extended) (\S+)\s*$/))) { current = { name: m[2], kind: m[1] as Acl["kind"], aces: [] }; acls.set(current.name, current); }
      else if ((m = raw.match(/^interface (\S+)/))) iface = normIf(m[1]);
      else if ((m = raw.match(/^access-list (\d+) (permit|deny) (.*)$/))) {
        const name = m[1];
        const acl = acls.get(name) ?? { name, kind: numberedKind(Number(name)), aces: [] };
        acls.set(name, acl);
        const ace = parseAce(`${m[2]} ${m[3]}`, acl.kind);
        if (ace) { ace.seq = (acl.aces.at(-1)?.seq ?? 0) + 10; ace.raw = raw.trim(); acl.aces.push(ace); }
      }
    } else if (current) {
      if (!/^\s+remark\b/.test(raw)) {
        const ace = parseAce(raw, current.kind);
        if (ace) { if (!ace.seq) ace.seq = (current.aces.at(-1)?.seq ?? 0) + 10; current.aces.push(ace); }
      }
    } else if (iface && (m = raw.match(/^\s+ip access-group (\S+) (in|out)\s*$/))) {
      uses.push({ acl: m[1], iface, direction: m[2], raw: raw.trim() });
    }
  }
  for (const a of acls.values()) a.aces.sort((x, y) => x.seq - y.seq);
  return { acls, uses };
}

/** Does address spec `a` match every address `b` matches? (Wildcard bits set mean "any value".) */
const covers = (a: Addr, b: Addr) => ((b.wild & ~a.wild) >>> 0) === 0 && (((a.addr ^ b.addr) & ~a.wild) >>> 0) === 0;
const portCovers = (a: PortSpec | null, b: PortSpec | null) => a === null || (b !== null && a.op === b.op && a.values.join(",") === b.values.join(","));
const protoCovers = (a: string, b: string) => a === "ip" || a === b;

/** Whether an earlier entry `a` already decides every packet entry `b` would. Anything uncertain says no. */
export function shadows(a: Ace, b: Ace): boolean {
  return protoCovers(a.proto, b.proto) && covers(a.src, b.src) && covers(a.dst, b.dst) && portCovers(a.srcPort, b.srcPort) && portCovers(a.dstPort, b.dstPort) && (a.extra === "" || a.extra === b.extra);
}

// ---- baseline ------------------------------------------------------------------------------------------------
type Hit = { kind: string; severity: Finding["severity"]; title: string; description: string; evidence: string[]; cause: string; action: string; fix?: Fix };

/** Correct the remote AS on this router. It is one of two possible fixes (the other router's own AS could be the wrong one), so the note says so. */
function bgpFix(platform: TopoNode["platform"], local: string | null, neighbor: string, remote: string, label: string, otherLabel: string): { fix?: Fix } {
  if (!local || !/^\d+$/.test(local) || !/^\d+$/.test(remote)) return {};
  const note = `This sets the AS on ${label}. If ${otherLabel} is the one with the wrong AS, change that instead.`;
  const summary = `Set neighbor ${neighbor} to remote-as ${remote} on ${label}`;
  if (platform === "nxos") return { fix: { summary, note, commands: [`router bgp ${local}`, `neighbor ${neighbor}`, `remote-as ${remote}`] } };
  if (platform === "ios" || platform === "eos" || platform === undefined) return { fix: { summary, note, commands: [`router bgp ${local}`, `neighbor ${neighbor} remote-as ${remote}`] } };
  return {};
}

/** A small security and hygiene baseline read from the configuration text. */
export function baseline(config: string): Hit[] {
  const lines = config.split(/\r?\n/);
  const has = (re: RegExp) => lines.find((l) => re.test(l));
  const hits: Hit[] = [];
  const absent = (what: string) => `(no ${what} line in the running configuration)`;

  if (!has(/^ip ssh version 2\s*$/)) hits.push({ kind: "hygiene-ssh-v2", severity: "warning", title: "SSH version 2 is not enforced", description: "The configuration does not pin SSH to version 2, so version 1 may be accepted.", evidence: [absent("'ip ssh version 2'")], cause: "SSH was enabled without restricting the version.", action: "Add 'ip ssh version 2'.", fix: { summary: "Pin SSH to version 2", note: null, commands: ["ip ssh version 2"] } });

  // VTY lines: telnet allowed, explicitly or by leaving transport input at its default.
  const vtyBlocks: { header: string; body: string[] }[] = [];
  lines.forEach((l, i) => { if (/^line vty\b/.test(l)) { const body: string[] = []; for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) body.push(lines[j].trim()); vtyBlocks.push({ header: l.trim(), body }); } });
  for (const b of vtyBlocks) {
    const ti = b.body.find((l) => /^transport input\b/.test(l));
    if (ti && /\b(telnet|all)\b/.test(ti)) hits.push({ kind: "hygiene-telnet", severity: "warning", title: `Telnet is allowed on ${b.header}`, description: `${b.header} accepts Telnet, which sends credentials in clear text.`, evidence: [b.header, ti], cause: "transport input allows telnet or all.", action: "Use 'transport input ssh'.", fix: { summary: `Allow only SSH on ${b.header}`, note: "This stops Telnet logins on these lines. Make sure you, and Tiny Snitch, reach the device over SSH first; the preview warns if the change would cut off Tiny Snitch's own access.", commands: [b.header, "transport input ssh"] } });
    else if (!ti) hits.push({ kind: "hygiene-telnet-default", severity: "info", title: `${b.header} does not restrict the transport`, description: "No 'transport input' line, so the platform default applies, which may include Telnet.", evidence: [b.header, absent("'transport input'")], cause: "transport input was left at its default.", action: "Add 'transport input ssh'.", fix: { summary: `Allow only SSH on ${b.header}`, note: "This stops Telnet logins on these lines. Make sure you, and Tiny Snitch, reach the device over SSH first; the preview warns if the change would cut off Tiny Snitch's own access.", commands: [b.header, "transport input ssh"] } });
  }

  const enablePw = has(/^enable password\b/);
  if (enablePw) hits.push({ kind: "hygiene-enable-password", severity: "warning", title: "Enable password is stored without a hash", description: "'enable password' is reversible or clear text; 'enable secret' is hashed.", evidence: [enablePw.trim().replace(/(enable password)\s+(?:\d\s+)?\S+/, "$1 <hidden>")], cause: "An old-style enable password is configured.", action: "Use 'enable secret' and remove 'enable password'." });
  const userPw = lines.filter((l) => /^username \S+(?: privilege \d+)? password\b/.test(l));
  if (userPw.length) hits.push({ kind: "hygiene-username-password", severity: "warning", title: "Local users use a reversible password", description: `${userPw.length} local user(s) are set with 'password' instead of 'secret'.`, evidence: userPw.slice(0, 3).map((l) => l.replace(/(password)\s+(?:\d\s+)?\S+/, "$1 <hidden>")), cause: "Users were created with 'username ... password'.", action: "Re-create them with 'username ... secret'." });

  const snmp = lines.filter((l) => /^snmp-server community (public|private)\b/i.test(l));
  if (snmp.length) hits.push({ kind: "hygiene-snmp-default", severity: "warning", title: "SNMP uses a default community string", description: "A well-known community string ('public' or 'private') is configured.", evidence: snmp.slice(0, 3), cause: "A default SNMP community was left in place.", action: "Replace it with SNMPv3 or a long random community, and restrict it with an ACL." });

  const http = has(/^ip http server\s*$/);
  if (http) hits.push({ kind: "hygiene-http-server", severity: "warning", title: "The HTTP server is enabled", description: "'ip http server' exposes a clear-text management interface.", evidence: [http.trim()], cause: "The HTTP server was turned on.", action: "Use 'no ip http server', and 'ip http secure-server' only if you need it.", fix: { summary: "Turn the HTTP server off", note: "Anything that uses the device's web interface stops working. The HTTPS server, if enabled, is left alone.", commands: ["no ip http server"] } });

  if (!has(/^ntp (server|peer|master)\b/)) hits.push({ kind: "hygiene-ntp", severity: "info", title: "No NTP source is configured", description: "Without synchronised time, logs from different devices cannot be correlated.", evidence: [absent("'ntp server'")], cause: "NTP was not configured.", action: "Add at least one 'ntp server'." });
  if (!has(/^logging (host )?\d+\.\d+\.\d+\.\d+/) && !has(/^logging host\b/)) hits.push({ kind: "hygiene-logging", severity: "info", title: "No remote syslog server is configured", description: "Logs stay on the device and are lost on reload.", evidence: [absent("'logging host'")], cause: "Remote logging was not configured.", action: "Add 'logging host <address>'." });
  if (!has(/^aaa new-model\s*$/)) hits.push({ kind: "hygiene-aaa", severity: "info", title: "AAA is not enabled", description: "The device uses local login only; there is no central authentication or accounting.", evidence: [absent("'aaa new-model'")], cause: "AAA was not configured.", action: "Enable AAA with a central server if the network has one." });
  return hits;
}

// ---- the checks -------------------------------------------------------------------------------------------------
export type ExtraOptions = { compliance: boolean };

export function extraFindings(inputs: ExtraInput[], links: TopoLink[], mk: MakeFinding, opts: ExtraOptions): Finding[] {
  const out: Finding[] = [];
  const byId = new Map(inputs.map((i) => [i.node.id, i]));
  const CFG = "show running-config", STP = "show spanning-tree";
  const base = (i: ExtraInput) => ({ device: i.node.label, deviceId: i.node.id, interface: null as string | null, peer: null, linkId: null as string | null });

  const stp = new Map<string, StpVlan[]>();
  for (const i of inputs) if (i.stpText?.trim()) stp.set(i.node.id, parseStp(i.stpText));

  // Spanning tree: ports the switch itself marked inconsistent.
  for (const i of inputs) {
    for (const v of stp.get(i.node.id) ?? []) {
      for (const p of v.ports.filter((x) => x.inconsistent)) {
        out.push(mk({ ...base(i), interface: p.name, kind: "stp-inconsistent", severity: "warning", status: "confirmed", title: `Spanning-tree inconsistency on ${p.name} (${v.vlan})`,
          description: `${i.node.label} has put ${p.name} in a blocking state because of a spanning-tree inconsistency (${p.inconsistent}) for ${v.vlan}.`, evidence: [ev(i.node.label, STP, p.raw)],
          probableCause: "A port receiving BPDUs it should not (root guard, loop guard, PVID or type mismatch with the neighbour).", recommendedAction: "Check the neighbour's trunk, native VLAN and root/loop guard settings.", verification: `Confirmed from ${STP} on ${i.node.label}.` }));
      }
    }
  }

  // Spanning tree: directly linked switches that disagree on the root of a VLAN.
  for (const l of links) {
    const a = byId.get(l.source), b = byId.get(l.target);
    const sa = a && stp.get(a.node.id), sb = b && stp.get(b.node.id);
    if (!a || !b || !sa || !sb) continue;
    for (const va of sa) {
      const vb = sb.find((x) => x.vlan === va.vlan);
      if (!vb || !va.rootAddr || !vb.rootAddr || va.rootAddr === vb.rootAddr) continue;
      out.push(mk({ ...base(a), interface: normIf(l.sourceInterface), peer: { device: b.node.label, deviceId: b.node.id, interface: normIf(l.targetInterface) }, linkId: l.id, kind: "stp-root-disagreement", severity: "warning", status: "suspected",
        title: `Linked switches disagree on the ${va.vlan} root bridge`, description: `${a.node.label} sees ${va.rootAddr} as the ${va.vlan} root; ${b.node.label}, directly linked, sees ${vb.rootAddr}.`,
        evidence: [ev(a.node.label, STP, `${va.vlan} Root ID Address ${va.rootAddr}${va.isRoot ? " (this bridge is the root)" : ""}`), ev(b.node.label, STP, `${vb.vlan} Root ID Address ${vb.rootAddr}${vb.isRoot ? " (this bridge is the root)" : ""}`)],
        probableCause: "The VLAN is not carried between the two (trunk allowed list or pruning), or BPDUs are being filtered, so each side built its own tree.", recommendedAction: "Check that the VLAN is allowed on the trunk and that no BPDU filter is set.", verification: `Suspected: run 'show interfaces trunk' on both switches and confirm ${va.vlan} is allowed and forwarding.` }));
    }
  }

  // IS-IS: a neighbour that is not UP, and a link that both ends run IS-IS on but where no adjacency formed.
  const isisOf = new Map<string, { neighbors: IsisNeighbor[]; ifaces: { name: string; circuit: string | null }[] }>();
  for (const i of inputs) if (i.isisText?.trim() && i.configText) isisOf.set(i.node.id, { neighbors: parseIsisNeighbors(i.isisText), ifaces: isisInterfaces(i.configText) });
  const ISIS = "show isis neighbors";
  for (const i of inputs) {
    for (const n of isisOf.get(i.node.id)?.neighbors ?? []) {
      if (n.state === "UP") continue;
      out.push(mk({ ...base(i), interface: n.interface, kind: "isis-neighbor-not-up", severity: "warning", status: "confirmed", title: `IS-IS neighbour ${n.systemId} on ${n.interface} is ${n.state}`,
        description: `${i.node.label} sees ${n.systemId} on ${n.interface} but the adjacency is ${n.state}, not UP, so no routes are exchanged over it.`, evidence: [ev(i.node.label, ISIS, n.raw)],
        probableCause: "The two ends disagree on something the adjacency needs (circuit type, area, authentication, MTU), or the link is dropping packets.", recommendedAction: `Compare the IS-IS interface and process settings on ${i.node.label} and ${n.systemId}.`, verification: `Confirmed from ${ISIS} on ${i.node.label}.` }));
    }
  }
  for (const l of links) {
    const a = byId.get(l.source), b = byId.get(l.target);
    const ia = a && isisOf.get(a.node.id), ib = b && isisOf.get(b.node.id);
    if (!a || !b || !ia || !ib) continue;
    const an = normIf(l.sourceInterface), bn = normIf(l.targetInterface);
    const ca = ia.ifaces.find((x) => x.name === an), cb = ib.ifaces.find((x) => x.name === bn);
    if (!ca || !cb) continue; // IS-IS is not run on both ends: nothing is expected
    const up = (i: ExtraInput, n: string) => { const r = i.brief?.get(n); return !!r && r.status === "up" && r.protocol === "up"; };
    if (!up(a, an) || !up(b, bn)) continue; // the interface findings already say why
    const seen = (side: { neighbors: IsisNeighbor[] }, n: string) => side.neighbors.some((x) => x.interface === n);
    if (seen(ia, an) || seen(ib, bn)) continue;
    const shared = levelsOf(ca.circuit).filter((x) => levelsOf(cb.circuit).includes(x));
    const cause = !shared.length ? `The circuit types do not overlap: ${a.node.label} asks for ${ca.circuit}, ${b.node.label} for ${cb.circuit}, so they can never form an adjacency.` : "Both interfaces are up and run IS-IS, so something the adjacency needs differs: area, authentication, MTU or the process on one side.";
    out.push(mk({ ...base(a), interface: an, peer: { device: b.node.label, deviceId: b.node.id, interface: bn }, linkId: l.id, kind: "isis-adjacency-missing", severity: "critical", status: "confirmed", title: "IS-IS adjacency missing",
      description: `${a.node.label} ${an} and ${b.node.label} ${bn} are cabled together, both up/up and both configured with 'ip router isis', but neither lists the other as an IS-IS neighbour.`,
      evidence: [ev(a.node.label, ISIS, `no neighbour on ${an}`), ev(b.node.label, ISIS, `no neighbour on ${bn}`), ...(ca.circuit ? [ev(a.node.label, CFG, `${an}: isis circuit-type ${ca.circuit}`)] : []), ...(cb.circuit ? [ev(b.node.label, CFG, `${bn}: isis circuit-type ${cb.circuit}`)] : [])],
      probableCause: cause, recommendedAction: `On both routers compare 'show isis neighbors detail', the 'net' address (area), 'is-type', any IS-IS authentication and the interface MTU.`, verification: `Confirmed from ${ISIS} on both routers and the interface configuration.` }));
  }

  // BGP: a peer that is not established because the AS configured for it is not the AS the other router runs. The cause is
  // only claimed when the router that owns the peer's address was also read, so both ASes are shown from device output.
  const localAs = (t: string | null | undefined) => t?.match(/local AS number (\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const owners = new Map<string, ExtraInput>();
  for (const i of inputs) for (const r of i.brief?.values() ?? []) if (r.ip && r.status !== "deleted") owners.set(r.ip, i);
  for (const i of inputs) {
    if (!i.bgpText) continue;
    for (const p of parseBgpSummary(i.bgpText)) {
      if (p.state === "Established") continue;
      const o = owners.get(p.neighbor);
      const theirs = o && o !== i ? localAs(o.bgpText) : null;
      if (!o || !theirs || theirs === p.as) continue;
      const header = o.bgpText!.split(/\r?\n/).find((l) => /local AS number/i.test(l))!.trim();
      const escaped = p.neighbor.replace(/\./g, "\\.");
      const cfgLine = i.configText?.split(/\r?\n/).find((l) => new RegExp(`^\\s*neighbor ${escaped} remote-as\\b`).test(l));
      out.push(mk({ ...base(i), kind: "bgp-as-mismatch", severity: "critical", status: "confirmed", peer: { device: o.node.label, deviceId: o.node.id, interface: "" },
        title: `BGP peer ${p.neighbor} is set to AS ${p.as}, but ${o.node.label} runs AS ${theirs}`,
        description: `${i.node.label} expects ${p.neighbor} to be in AS ${p.as}, and that address belongs to ${o.node.label}, which is in AS ${theirs}. A BGP session cannot come up while the two disagree.`,
        evidence: [ev(i.node.label, "show ip bgp summary", p.raw), ...(cfgLine ? [ev(i.node.label, CFG, cfgLine)] : []), ev(o.node.label, "show ip bgp summary", header)],
        probableCause: `The remote-as on ${i.node.label} was mistyped, or ${o.node.label} was given the wrong AS.`,
        recommendedAction: `Set "neighbor ${p.neighbor} remote-as ${theirs}" on ${i.node.label}, or correct the AS on ${o.node.label} if that is the one that is wrong.`,
        verification: `Confirmed from show ip bgp summary on both routers${cfgLine ? " and the neighbor line in the configuration" : ""}.`,
        ...bgpFix(i.node.platform, localAs(i.bgpText), p.neighbor, theirs, i.node.label, o.node.label) }));
    }
  }

  for (const i of inputs) {
    if (!i.configText) continue;
    const label = i.node.label;

    // Static routes whose next hop cannot be reached through any connected subnet.
    if (i.cfg) {
      const nets = [...i.cfg.interfaces.values()].filter((x) => x.ip && x.plen !== null).map((x) => ({ name: x.name, ip: ip4(x.ip!), plen: x.plen! }));
      for (const r of parseStaticRoutes(i.configText)) {
        if (!r.nextHop) continue;
        const nh = ip4(r.nextHop);
        const inNet = (n: { ip: number; plen: number }) => n.plen === 0 || (nh >>> (32 - n.plen)) === (n.ip >>> (32 - n.plen));
        const covering = nets.filter(inNet);
        if (covering.length === 0) {
          out.push(mk({ ...base(i), kind: "static-route-nexthop", severity: "warning", status: "suspected", title: `Static route next hop ${r.nextHop} is not in a connected subnet`, description: `The route "${r.raw}" on ${label} points at ${r.nextHop}, which is not inside any connected subnet. It works only if that address is reachable through another route.`,
            evidence: [ev(label, CFG, r.raw)], probableCause: "A wrong next hop, a missing interface address, or a deliberately recursive route.", recommendedAction: "Check the next hop against the addressing plan.", verification: `Suspected: run 'show ip route ${r.nextHop}' on ${label} to see whether it is reachable.` }));
        } else if (i.brief) {
          const live = covering.some((n) => { const b = i.brief!.get(n.name); return b?.status === "up" && b.protocol === "up"; });
          const known = covering.every((n) => i.brief!.has(n.name));
          if (!live && known) {
            const c = covering[0], b = i.brief.get(c.name)!;
            out.push(mk({ ...base(i), interface: c.name, kind: "static-route-nexthop-down", severity: "warning", status: "confirmed", title: `Static route next hop ${r.nextHop} is behind a down interface`, description: `The route "${r.raw}" on ${label} needs ${c.name}, which is ${b.status}/${b.protocol}, so the route is not installed.`,
              evidence: [ev(label, CFG, r.raw), ev(label, "show ip interface brief", `${b.name} ${b.ip ?? "unassigned"} ${b.status}/${b.protocol}`)], probableCause: "The interface the next hop sits behind is down or shut.", recommendedAction: `Bring ${c.name} up, or point the route elsewhere.`, verification: `Confirmed from the configuration and show ip interface brief on ${label}.` }));
          }
        }
      }
    }

    // ACLs: entries that can never match, duplicates, and ACLs applied but not defined.
    const { acls, uses } = parseAcls(i.configText);
    for (const u of uses) {
      if (!acls.has(u.acl)) out.push(mk({ ...base(i), interface: u.iface, kind: "acl-undefined", severity: "warning", status: "confirmed", title: `${u.iface} uses ACL ${u.acl}, which is not defined`,
        description: `${u.iface} on ${label} applies "${u.acl}" ${u.direction}bound, but no such ACL exists. On IOS an undefined ACL permits all traffic.`, evidence: [ev(label, CFG, `interface ${u.iface}`), ev(label, CFG, u.raw)],
        probableCause: "The ACL was deleted or renamed, or the name is mistyped.", recommendedAction: "Define the ACL, or remove the access-group.", verification: `Confirmed from ${CFG} on ${label}: no ACL named ${u.acl}.` }));
    }
    for (const acl of acls.values()) {
      let reported = 0;
      acl.aces.forEach((b, j) => {
        const a = acl.aces.slice(0, j).find((x) => shadows(x, b));
        if (!a || reported >= 10) return;
        reported++;
        const conflict = a.action !== b.action;
        out.push(mk({ ...base(i), kind: conflict ? "acl-conflict" : "acl-redundant", severity: conflict ? "warning" : "info", status: "confirmed",
          title: `${conflict ? "ACL entry never matches" : "Redundant ACL entry"}: ${acl.name} "${b.raw.replace(/^\d+\s+/, "")}"`,
          description: conflict ? `In ACL ${acl.name} on ${label}, "${b.raw}" can never match: the earlier entry "${a.raw}" already ${a.action === "permit" ? "permits" : "denies"} every packet it would ${b.action}.` : `In ACL ${acl.name} on ${label}, "${b.raw}" repeats the effect of the earlier entry "${a.raw}".`,
          evidence: [ev(label, CFG, a.raw), ev(label, CFG, b.raw)], probableCause: conflict ? "Entries are in the wrong order, or the earlier one is broader than intended." : "A duplicated or leftover entry.", recommendedAction: conflict ? "Reorder the entries, or narrow the earlier one." : "Remove the redundant entry.", verification: `Confirmed from ${CFG} on ${label}.` }));
      });
    }

    // Baseline.
    if (opts.compliance) {
      for (const h of baseline(i.configText)) {
        out.push(mk({ ...base(i), kind: h.kind, severity: h.severity, status: "confirmed", title: h.title, description: `${h.description} (${label})`, evidence: h.evidence.map((e) => (e.startsWith("(") ? ev(label, CFG, e) : ev(label, CFG, e))),
          probableCause: h.cause, recommendedAction: h.action, verification: `Confirmed from ${CFG} on ${label}.`, ...(h.fix ? { fix: h.fix } : {}) }));
      }
    }
  }
  out.push(...bgpPolicyFindings(inputs.map((i) => ({ node: i.node, configText: i.configText, bgpText: i.bgpText, brief: i.brief })), mk));
  return out;
}
