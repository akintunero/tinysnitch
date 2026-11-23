/**
 * Arista EOS output, normalised to the same shapes the IOS parsers return so the checks do not care which dialect
 * a device speaks. Written from EOS's documented output formats and tested on samples laid out that way; they have
 * not yet been run against a real EOS device, and the README says so.
 */
import { type BgpPeer, type DeviceCfg, type IfBriefRow, type OspfNeighbor, normIf, parseRunningConfig } from "./parsers";

const PREFIX = "(?:\\d{1,3}\\.){3}\\d{1,3}";

export function parseEosIpIntBrief(text: string): IfBriefRow[] {
  const rows: IfBriefRow[] = [];
  const re = new RegExp(`^(\\S+)\\s+(unassigned|${PREFIX}(?:/\\d+)?)\\s+(admin down|administratively down|adminDown|up|down|lowerLayerDown|notPresent)\\s+(up|down|lowerLayerDown|notPresent|dormant)\\b`, "i");
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m) continue;
    const status = /^admin/i.test(m[3]) ? "administratively down" : m[3].toLowerCase() === "up" ? "up" : "down";
    rows.push({ name: normIf(m[1]), ip: m[2].toLowerCase() === "unassigned" ? null : m[2].split("/")[0], status, protocol: m[4].toLowerCase() === "up" ? "up" : "down" });
  }
  return rows;
}

export function parseEosOspfNeighbors(text: string): OspfNeighbor[] {
  const rows: OspfNeighbor[] = [];
  const re = new RegExp(`^(${PREFIX})\\s+\\d+\\s+\\S+\\s+\\d+\\s+([A-Z0-9-]+)(?:/\\s*(\\S+))?\\s+\\S+\\s+(${PREFIX})\\s+(\\S+)\\s*$`);
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m) rows.push({ neighborId: m[1], state: m[2], role: m[3] ?? "", address: m[4], interface: normIf(m[5]) });
  }
  return rows;
}

export function parseEosBgpSummary(text: string): BgpPeer[] {
  const rows: BgpPeer[] = [];
  const re = new RegExp(`^(${PREFIX})\\s+\\d\\s+(\\d+(?:\\.\\d+)?)\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\S+)\\s+(\\S+)(?:\\s+(\\d+))?(?:\\s+\\d+)?\\s*$`);
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m) continue;
    const established = /^estab/i.test(m[4]);
    rows.push({ neighbor: m[1], as: m[2], upDown: m[3], state: established ? "Established" : m[4], prefixes: established && m[5] !== undefined ? Number(m[5]) : null, raw: line.trim() });
  }
  return rows;
}

const mask = (n: number) => [0, 1, 2, 3].map((i) => { const b = Math.min(8, Math.max(0, n - i * 8)); return 256 - 2 ** (8 - b); }).join(".");
const wildcard = (n: number) => mask(n).split(".").map((o) => 255 - Number(o)).join(".");

/** EOS writes CIDR where IOS writes masks; rewrite those lines so the one config parser reads both. */
export function parseEosConfig(text: string): DeviceCfg {
  const ospfPid = text.match(/^router\s+ospf\s+(\d+)/im)?.[1] ?? "1";
  const out = text.split(/\r?\n/).map((raw) => {
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(\s+ip\s+address\s+)(\d+\.\d+\.\d+\.\d+)\/(\d+)\s*$/i))) return `${m[1]}${m[2]} ${mask(Number(m[3]))}`;
    if ((m = raw.match(/^(\s+network\s+)(\d+\.\d+\.\d+\.\d+)\/(\d+)(\s+area\s+\S+)\s*$/i))) return `${m[1]}${m[2]} ${wildcard(Number(m[3]))}${m[4]}`;
    if ((m = raw.match(/^(\s+)ip\s+ospf\s+area\s+(\S+)\s*$/i))) return `${m[1]}ip ospf ${ospfPid} area ${m[2]}`;
    return raw;
  });
  return parseRunningConfig(out.join("\n"));
}

export function parseEosPing(text: string): { successRate: number; received: number; sent: number } | null {
  const m = text.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received/i);
  if (!m) return null;
  const sent = Number(m[1]), received = Number(m[2]);
  return sent ? { successRate: Math.round((received / sent) * 100), received, sent } : null;
}
