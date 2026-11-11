/**
 * Juniper Junos output, normalised to the shapes the IOS parsers return. Written from Junos's documented output
 * formats and tested on samples laid out that way; not yet run against a real Junos device, and the README says so.
 */
import { type BgpPeer, type DeviceCfg, type IfBriefRow, type IfaceCfg, type OspfNeighbor, normIf } from "./parsers";

const IP = "(?:\\d{1,3}\\.){3}\\d{1,3}";
const physical = (n: string) => n.replace(/\.\d+$/, "");

/**
 * `show interfaces terse`. Rows are keyed by the physical interface; its address and operational state come from
 * the first `inet` unit, because that is where a link's IP lives and what the topology's link ends name.
 */
export function parseJunosInterfacesTerse(text: string): IfBriefRow[] {
  const phys = new Map<string, IfBriefRow>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^Interface\s+Admin/i.test(raw.trim())) continue;
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(\S+)\s+(up|down)\s+(up|down)(?:\s+(\S+)(?:\s+(\S.*))?)?\s*$/i))) {
      const [, name, admin, link, proto, rest] = m;
      current = name;
      const base = physical(name);
      if (!/\.\d+$/.test(name)) {
        phys.set(base, { name: normIf(base), ip: null, status: admin.toLowerCase() === "down" ? "administratively down" : link.toLowerCase() === "up" ? "up" : "down", protocol: link.toLowerCase() === "up" && admin.toLowerCase() === "up" ? "up" : "down" });
      } else if (proto?.toLowerCase() === "inet") {
        const row = phys.get(base);
        const ip = rest?.match(new RegExp(`^(${IP})`))?.[1];
        if (row && ip && !row.ip) row.ip = ip;
      }
    } else if (current && (m = raw.match(new RegExp(`^\\s+inet\\s+(${IP})`)))) {
      const row = phys.get(physical(current));
      if (row && !row.ip) row.ip = m[1];
    }
  }
  return [...phys.values()];
}

/** `show ospf neighbor`. */
export function parseJunosOspfNeighbors(text: string): OspfNeighbor[] {
  const rows: OspfNeighbor[] = [];
  const re = new RegExp(`^(${IP})\\s+(\\S+)\\s+(Full|Init|2Way|ExStart|Exchange|Loading|Down|Attempt)\\s+(${IP})\\s+\\d+\\s+\\d+\\s*$`, "i");
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m) rows.push({ neighborId: m[4], state: m[3].toUpperCase(), role: "", address: m[1], interface: normIf(physical(m[2])) });
  }
  return rows;
}

/** `show bgp summary`. A peer line may be followed by an indented "table: active/received/accepted/damped" line. */
export function parseJunosBgpSummary(text: string): BgpPeer[] {
  const rows: BgpPeer[] = [];
  const re = new RegExp(`^(${IP}|[0-9a-f:]+)\\s+(\\d+(?:\\.\\d+)?)\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\S+)\\s+(\\S+)\\s*$`, "i");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(re);
    if (!m) continue;
    const established = /^estab/i.test(m[4]);
    const received = established ? lines[i + 1]?.trim().match(/^\S+:\s*(\d+)\/(\d+)\/(\d+)/)?.[2] : undefined;
    rows.push({ neighbor: m[1], as: m[2], upDown: m[3], state: established ? "Established" : m[4], prefixes: received !== undefined ? Number(received) : null, raw: lines[i].trim() });
  }
  return rows;
}

const area = (a: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(a) ? String(a.split(".").reduce((n, o) => n * 256 + Number(o), 0)) : /^\d+$/.test(a) ? String(Number(a)) : a);

/** `show configuration | display set`: one flat `set ...` line per setting. */
export function parseJunosConfig(text: string): DeviceCfg {
  const cfg: DeviceCfg = { hostname: null, interfaces: new Map(), ospf: null, bgp: null };
  const iface = (n: string): IfaceCfg => {
    const name = normIf(physical(n));
    let i = cfg.interfaces.get(name);
    if (!i) { i = { name, shutdown: false, ip: null, plen: null, mtu: null, description: null, ospf: null, mode: null, accessVlan: null, nativeVlan: null, allowed: null, channelGroup: null }; cfg.interfaces.set(name, i); }
    return i;
  };
  const ospf = () => (cfg.ospf ??= { pid: "1", routerId: null, passiveDefault: false, passive: [], noPassive: [], networks: [] });
  const ospfIfaces: { name: string; area: string; passive: boolean }[] = [];
  let asn: string | null = null;
  let routerId: string | null = null;
  const peers: { ip: string; remoteAs: string | null; shutdown: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if (!line.startsWith("set ")) continue;
    if ((m = line.match(/^set system host-name (\S+)/))) cfg.hostname = m[1];
    else if ((m = line.match(/^set interfaces (\S+) disable$/))) iface(m[1]).shutdown = true;
    else if ((m = line.match(/^set interfaces (\S+) description "?(.*?)"?$/))) iface(m[1]).description = m[2];
    else if ((m = line.match(/^set interfaces (\S+) mtu (\d+)$/))) iface(m[1]).mtu = Number(m[2]);
    else if ((m = line.match(new RegExp(`^set interfaces (\\S+) unit \\d+ family inet address (${IP})/(\\d+)`)))) {
      const i = iface(m[1]);
      if (!i.ip) { i.ip = m[2]; i.plen = Number(m[3]); }
    } else if ((m = line.match(/^set routing-options router-id (\S+)$/))) routerId = m[1];
    else if ((m = line.match(/^set routing-options autonomous-system (\S+)/))) asn = m[1];
    else if ((m = line.match(/^set protocols ospf area (\S+) interface (\S+?)(?:\.\d+)?( passive)?$/))) ospfIfaces.push({ name: normIf(m[2]), area: area(m[1]), passive: Boolean(m[3]) });
    else if ((m = line.match(/^set protocols ospf area (\S+) interface (\S+?)(?:\.\d+)? passive$/))) ospfIfaces.push({ name: normIf(m[2]), area: area(m[1]), passive: true });
    else if ((m = line.match(new RegExp(`^set protocols bgp group \\S+ neighbor (${IP}|[0-9a-f:]+)(?: peer-as (\\S+))?`, "i")))) {
      const p = peers.find((x) => x.ip === m![1]);
      if (p) { if (m[2]) p.remoteAs = m[2]; } else peers.push({ ip: m[1], remoteAs: m[2] ?? null, shutdown: false });
    } else if ((m = line.match(new RegExp(`^set protocols bgp group (\\S+) peer-as (\\S+)`)))) {
      for (const p of peers) p.remoteAs ??= m[2];
    }
  }
  if (ospfIfaces.length) {
    const o = ospf();
    o.routerId = routerId;
    for (const x of ospfIfaces) {
      iface(x.name).ospf = { pid: "1", area: x.area };
      if (x.passive) o.passive.push(x.name);
    }
  }
  if (asn || peers.length) cfg.bgp = { asn: asn ?? "", routerId, neighbors: peers };
  return cfg;
}
