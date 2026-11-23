/** Parsers for IOS / IOS-XE show output. Each returns only what it can read; unreadable lines are skipped, never guessed. */

const PREFIXES: Record<string, string> = {
  gi: "GigabitEthernet", gigabitethernet: "GigabitEthernet", fa: "FastEthernet", fastethernet: "FastEthernet",
  te: "TenGigabitEthernet", tengigabitethernet: "TenGigabitEthernet", eth: "Ethernet", et: "Ethernet", ethernet: "Ethernet",
  lo: "Loopback", loopback: "Loopback", se: "Serial", serial: "Serial", po: "Port-channel", "port-channel": "Port-channel", vl: "Vlan", vlan: "Vlan",
};

/** Gi0/1, GigabitEthernet0/1 and gigabitethernet 0/1 all become GigabitEthernet0/1. */
export function normIf(name: string): string {
  const m = name.trim().match(/^([A-Za-z-]+?)\s*(\d[\d/.]*)$/);
  if (!m) return name.trim();
  return (PREFIXES[m[1].toLowerCase()] ?? m[1]) + m[2];
}

const plen = (mask: string) => mask.split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0);

// ---- show ip interface brief ----------------------------------------------------------------------------
export type IfBriefRow = { name: string; ip: string | null; status: string; protocol: string };
const BRIEF = /^(\S+)\s+(\S+)\s+(?:YES|NO)\s+\S+\s+(administratively down|up|down|deleted)\s+(up|down)\s*$/i;

export function parseIpIntBrief(text: string): IfBriefRow[] {
  const rows: IfBriefRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(BRIEF);
    if (m) rows.push({ name: normIf(m[1]), ip: m[2].toLowerCase() === "unassigned" ? null : m[2], status: m[3].toLowerCase(), protocol: m[4].toLowerCase() });
  }
  return rows;
}

// ---- show ip ospf neighbor ------------------------------------------------------------------------------
export type OspfNeighbor = { neighborId: string; state: string; role: string; address: string; interface: string };
const NBR = /^(\d+\.\d+\.\d+\.\d+)\s+\d+\s+([A-Z0-9]+)(?:\/\s*(\S+))?\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s*$/;

export function parseOspfNeighbors(text: string): OspfNeighbor[] {
  const rows: OspfNeighbor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(NBR);
    if (m) rows.push({ neighborId: m[1], state: m[2], role: m[3] ?? "", address: m[4], interface: normIf(m[5]) });
  }
  return rows;
}

// ---- show ip bgp summary --------------------------------------------------------------------------------
export type BgpPeer = { neighbor: string; as: string; upDown: string; state: string; prefixes: number | null; raw: string };
const BGP = /^(\d+\.\d+\.\d+\.\d+)\s+\d\s+(\d+(?:\.\d+)?)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\S+)\s+(.+?)\s*$/;

export function parseBgpSummary(text: string): BgpPeer[] {
  const rows: BgpPeer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(BGP);
    if (!m) continue;
    const established = /^\d+$/.test(m[4]);
    rows.push({ neighbor: m[1], as: m[2], upDown: m[3], state: established ? "Established" : m[4], prefixes: established ? Number(m[4]) : null, raw: line.trim() });
  }
  return rows;
}

// ---- show running-config --------------------------------------------------------------------------------
export type IfaceCfg = {
  name: string; shutdown: boolean; ip: string | null; plen: number | null; mtu: number | null; description: string | null;
  ospf: { pid: string; area: string } | null; mode: "access" | "trunk" | null; accessVlan: number | null;
  nativeVlan: number | null; allowed: string | null; channelGroup: number | null;
};
export type OspfCfg = { pid: string; routerId: string | null; passiveDefault: boolean; passive: string[]; noPassive: string[]; networks: { addr: string; wildcard: string; area: string }[] };
export type BgpCfg = { asn: string; routerId: string | null; neighbors: { ip: string; remoteAs: string | null; shutdown: boolean }[] };
export type DeviceCfg = { hostname: string | null; interfaces: Map<string, IfaceCfg>; ospf: OspfCfg | null; bgp: BgpCfg | null };

const area = (a: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(a) ? String(a.split(".").reduce((n, o) => n * 256 + Number(o), 0)) : /^\d+$/.test(a) ? String(Number(a)) : a);

export function parseRunningConfig(text: string): DeviceCfg {
  const cfg: DeviceCfg = { hostname: null, interfaces: new Map(), ospf: null, bgp: null };
  let ctx: { type: "if"; cur: IfaceCfg } | { type: "ospf" } | { type: "bgp" } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!")) continue;
    if (!/^\s/.test(raw)) {
      ctx = null;
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^hostname\s+(\S+)/i))) cfg.hostname = m[1];
      else if ((m = line.match(/^interface\s+(\S+)$/i))) {
        const name = normIf(m[1]);
        const cur: IfaceCfg = { name, shutdown: false, ip: null, plen: null, mtu: null, description: null, ospf: null, mode: null, accessVlan: null, nativeVlan: null, allowed: null, channelGroup: null };
        cfg.interfaces.set(name, cur);
        ctx = { type: "if", cur };
      } else if ((m = line.match(/^router\s+ospf\s+(\d+)/i))) {
        cfg.ospf = { pid: m[1], routerId: null, passiveDefault: false, passive: [], noPassive: [], networks: [] };
        ctx = { type: "ospf" };
      } else if ((m = line.match(/^router\s+bgp\s+(\S+)/i))) {
        cfg.bgp = { asn: m[1], routerId: null, neighbors: [] };
        ctx = { type: "bgp" };
      }
      continue;
    }
    if (!ctx) continue;
    let m: RegExpMatchArray | null;
    if (ctx.type === "if") {
      const c = ctx.cur;
      if (/^shutdown$/i.test(line)) c.shutdown = true;
      else if (/^no\s+shutdown$/i.test(line)) c.shutdown = false;
      else if ((m = line.match(/^ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i))) { c.ip = m[1]; c.plen = plen(m[2]); }
      else if (/^no\s+ip\s+address$/i.test(line)) { c.ip = null; c.plen = null; }
      else if ((m = line.match(/^ip\s+mtu\s+(\d+)$/i))) c.mtu = Number(m[1]);
      else if ((m = line.match(/^mtu\s+(\d+)$/i))) c.mtu ??= Number(m[1]);
      else if ((m = line.match(/^description\s+(.+)$/i))) c.description = m[1];
      else if ((m = line.match(/^ip\s+ospf\s+(\d+)\s+area\s+(\S+)/i))) c.ospf = { pid: m[1], area: area(m[2]) };
      else if ((m = line.match(/^switchport\s+mode\s+(access|trunk)/i))) c.mode = m[1].toLowerCase() as "access" | "trunk";
      else if ((m = line.match(/^switchport\s+access\s+vlan\s+(\d+)/i))) c.accessVlan = Number(m[1]);
      else if ((m = line.match(/^switchport\s+trunk\s+native\s+vlan\s+(\d+)/i))) c.nativeVlan = Number(m[1]);
      else if ((m = line.match(/^switchport\s+trunk\s+allowed\s+vlan\s+(?:add\s+)?(\S+)/i))) c.allowed = m[1];
      else if ((m = line.match(/^channel-group\s+(\d+)/i))) c.channelGroup = Number(m[1]);
    } else if (ctx.type === "ospf" && cfg.ospf) {
      const o = cfg.ospf;
      if ((m = line.match(/^router-id\s+(\S+)/i))) o.routerId = m[1];
      else if (/^passive-interface\s+default$/i.test(line)) o.passiveDefault = true;
      else if ((m = line.match(/^no\s+passive-interface\s+(\S+)/i))) o.noPassive.push(normIf(m[1]));
      else if ((m = line.match(/^passive-interface\s+(\S+)/i))) o.passive.push(normIf(m[1]));
      else if ((m = line.match(/^network\s+(\S+)\s+(\S+)\s+area\s+(\S+)/i))) o.networks.push({ addr: m[1], wildcard: m[2], area: area(m[3]) });
    } else if (ctx.type === "bgp" && cfg.bgp) {
      const b = cfg.bgp;
      if ((m = line.match(/^bgp\s+router-id\s+(\S+)/i))) b.routerId = m[1];
      else if ((m = line.match(/^neighbor\s+(\S+)\s+remote-as\s+(\S+)/i))) b.neighbors.push({ ip: m[1], remoteAs: m[2], shutdown: false });
      else if ((m = line.match(/^neighbor\s+(\S+)\s+shutdown$/i))) {
        const n = b.neighbors.find((x) => x.ip === m![1]);
        if (n) n.shutdown = true;
        else b.neighbors.push({ ip: m[1], remoteAs: null, shutdown: true });
      }
    }
  }
  return cfg;
}

const ip4 = (s: string) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** Which OSPF area an interface is in, from an interface-level command or a covering network statement. */
export function ospfFor(cfg: DeviceCfg, i: IfaceCfg): { area: string; passive: boolean } | null {
  if (!cfg.ospf) return null;
  let a = i.ospf?.area ?? null;
  if (a === null && i.ip) {
    for (const n of cfg.ospf.networks) {
      const mask = ~ip4(n.wildcard) >>> 0;
      if (((ip4(i.ip) & mask) >>> 0) === ((ip4(n.addr) & mask) >>> 0)) { a = n.area; break; }
    }
  }
  if (a === null) return null;
  const passive = cfg.ospf.passive.includes(i.name) || (cfg.ospf.passiveDefault && !cfg.ospf.noPassive.includes(i.name));
  return { area: a, passive };
}

// ---- show vlan brief / interfaces trunk / etherchannel ----------------------------------------------------
/** Port (normalised) to access VLAN id, from `show vlan brief`. Trunk ports do not appear there. */
export function parseVlanBrief(text: string): Map<string, string> {
  const ports = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\s+(\S+)\s+(?:active|act\/unsup|suspended\S*)\s*(.*)$/i);
    if (m) {
      current = m[1];
      for (const p of m[3].split(",").map((s) => s.trim()).filter(Boolean)) ports.set(normIf(p), current);
    } else if (current && /^\s+[A-Za-z]/.test(line)) {
      for (const p of line.split(",").map((s) => s.trim()).filter(Boolean)) ports.set(normIf(p), current);
    } else if (/^\d+\s/.test(line)) current = null;
  }
  return ports;
}

export type TrunkPort = { port: string; mode: string; encapsulation: string; status: string; native: string; allowed: string | null };
export function parseTrunk(text: string): TrunkPort[] {
  const ports = new Map<string, TrunkPort>();
  let section: "modes" | "allowed" | "other" | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^Port\s+Mode\s+Encapsulation/i.test(t)) { section = "modes"; continue; }
    if (/^Port\s+Vlans allowed on trunk/i.test(t)) { section = "allowed"; continue; }
    if (/^Port\s+Vlans/i.test(t)) { section = "other"; continue; }
    let m: RegExpMatchArray | null;
    if (section === "modes" && (m = t.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/))) {
      ports.set(normIf(m[1]), { port: normIf(m[1]), mode: m[2], encapsulation: m[3], status: m[4], native: m[5], allowed: null });
    } else if (section === "allowed" && (m = t.match(/^(\S+)\s+(\S+)$/))) {
      const p = ports.get(normIf(m[1]));
      if (p) p.allowed = m[2];
    }
  }
  return [...ports.values()];
}

export type EtherChannel = { group: number; portChannel: string; flags: string; protocol: string; members: { port: string; flag: string }[] };
export function parseEtherchannel(text: string): EtherChannel[] {
  const out: EtherChannel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(Po\d+)\(([A-Za-z]+)\)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const members = [...m[5].matchAll(/(\S+?)\((\w)\)/g)].map((x) => ({ port: normIf(x[1]), flag: x[2] }));
    out.push({ group: Number(m[1]), portChannel: normIf(m[2]), flags: m[3], protocol: m[4], members });
  }
  return out;
}

// ---- ping -------------------------------------------------------------------------------------------------
export function parsePing(text: string): { successRate: number; received: number; sent: number } | null {
  const m = text.match(/Success rate is (\d+) percent \((\d+)\/(\d+)\)/i);
  return m ? { successRate: Number(m[1]), received: Number(m[2]), sent: Number(m[3]) } : null;
}
