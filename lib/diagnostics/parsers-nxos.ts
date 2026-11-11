/**
 * Cisco NX-OS output, normalised to the shapes the IOS parsers return. Written from NX-OS's documented output
 * formats and tested on samples laid out that way; not yet run against a real NX-OS device, and the README says so.
 */
import { type DeviceCfg, type IfBriefRow, type OspfNeighbor, normIf, parseRunningConfig } from "./parsers";

const IP = "(?:\\d{1,3}\\.){3}\\d{1,3}";

/** `show ip interface brief` (NX-OS prints "protocol-up/link-up/admin-up" per interface). */
export function parseNxosIpIntBrief(text: string): IfBriefRow[] {
  const rows: IfBriefRow[] = [];
  const re = new RegExp(`^(\\S+)\\s+(${IP}|unassigned)\\s+protocol-(up|down)/link-(up|down)/admin-(up|down)\\s*$`, "i");
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (!m) continue;
    const admin = m[5].toLowerCase() === "down";
    const link = m[4].toLowerCase() === "up";
    rows.push({ name: normIf(m[1]), ip: m[2].toLowerCase() === "unassigned" ? null : m[2], status: admin ? "administratively down" : link ? "up" : "down", protocol: m[3].toLowerCase() === "up" && !admin ? "up" : "down" });
  }
  return rows;
}

/** `show ip ospf neighbors`. */
export function parseNxosOspfNeighbors(text: string): OspfNeighbor[] {
  const rows: OspfNeighbor[] = [];
  const re = new RegExp(`^(${IP})\\s+\\d+\\s+([A-Z0-9-]+)(?:/\\s*(\\S+))?\\s+\\S+\\s+(${IP})\\s+(\\S+)\\s*$`);
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m) rows.push({ neighborId: m[1], state: m[2], role: m[3] ?? "", address: m[4], interface: normIf(m[5]) });
  }
  return rows;
}

const mask = (n: number) => [0, 1, 2, 3].map((i) => 256 - 2 ** (8 - Math.min(8, Math.max(0, n - i * 8)))).join(".");
const wildcard = (n: number) => mask(n).split(".").map((o) => 255 - Number(o)).join(".");

/** NX-OS writes CIDR and `ip router ospf N area A`; rewrite to the IOS forms so one config parser reads both. */
export function parseNxosConfig(text: string): DeviceCfg {
  const out = text.split(/\r?\n/).map((raw) => {
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(\s+ip\s+address\s+)(\d+\.\d+\.\d+\.\d+)\/(\d+)(\s+secondary)?\s*$/i))) return `${m[1]}${m[2]} ${mask(Number(m[3]))}${m[4] ?? ""}`;
    if ((m = raw.match(/^(\s+network\s+)(\d+\.\d+\.\d+\.\d+)\/(\d+)(\s+area\s+\S+)\s*$/i))) return `${m[1]}${m[2]} ${wildcard(Number(m[3]))}${m[4]}`;
    if ((m = raw.match(/^(\s+)ip\s+router\s+ospf\s+(\S+)\s+area\s+(\S+)\s*$/i))) return `${m[1]}ip ospf ${m[2]} area ${m[3]}`;
    return raw;
  });
  return parseRunningConfig(out.join("\n"));
}
