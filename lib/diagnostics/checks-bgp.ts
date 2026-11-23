/**
 * Route filters and prefix counts, from the configurations and `show ip bgp summary` of the routers that were read.
 *
 * Every number here is worked out from device output, not guessed: what a router originates comes from its `network`
 * statements, what a prefix-list lets through comes from evaluating its entries in order, and what a session received
 * comes from the summary. When the received count is exactly what the originated prefixes minus the filtered ones
 * predict, the finding says the count matches, which is the strongest evidence the filter is the cause.
 *
 * What it cannot know is intent: a filter may be doing its job. So a filter that removes some of a neighbour's
 * prefixes is reported as a warning with the effect spelled out, never as an error.
 */
import type { TopoNode } from "../cml/topology";
import { type BgpPeer, parseBgpSummary } from "./parsers";
import type { Finding } from "./types";

export type Prefix = { net: number; len: number };
export type PfxEntry = { seq: number; action: "permit" | "deny"; net: number; len: number; ge: number | null; le: number | null; raw: string };
export type NeighborPolicy = { ip: string; remoteAs: string | null; prefixListIn: string | null; prefixListOut: string | null; routeMapIn: string | null; routeMapOut: string | null; lines: string[] };
export type BgpPolicy = { localAs: string | null; networks: Prefix[]; neighbors: Map<string, NeighborPolicy>; routeMaps: Set<string>; routeMapPrefixLists: Map<string, string[]> };

const ip4 = (s: string) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0) >>> 0;
const fmt = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const plen = (mask: string) => mask.split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0);
const maskOf = (len: number) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
const inside = (p: Prefix, net: number, len: number) => p.len >= len && ((p.net & maskOf(len)) >>> 0) === ((net & maskOf(len)) >>> 0);
export const showPrefix = (p: Prefix) => `${fmt(p.net)}/${p.len}`;

// ---- prefix lists --------------------------------------------------------------------------------------------------------------------

const ENTRY = /^ip prefix-list\s+(\S+)\s+(?:seq\s+(\d+)\s+)?(permit|deny)\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)(?:\s+ge\s+(\d+))?(?:\s+le\s+(\d+))?\s*$/;

export function parsePrefixLists(config: string): Map<string, PfxEntry[]> {
  const out = new Map<string, PfxEntry[]>();
  let auto = 0;
  for (const line of config.split(/\r?\n/)) {
    const m = ENTRY.exec(line.trim());
    if (!m) continue;
    const list = out.get(m[1]) ?? [];
    auto += 5;
    list.push({ seq: m[2] ? Number(m[2]) : auto, action: m[3] as "permit" | "deny", net: ip4(m[4]), len: Number(m[5]), ge: m[6] ? Number(m[6]) : null, le: m[7] ? Number(m[7]) : null, raw: line.trim() });
    out.set(m[1], list);
  }
  for (const list of out.values()) list.sort((a, b) => a.seq - b.seq);
  return out;
}

/** The entry that decides a prefix (the first, by sequence number, that matches), or null when none does: an implicit deny. */
export function decidingEntry(list: PfxEntry[], p: Prefix): PfxEntry | null {
  for (const e of list) {
    if (!inside(p, e.net, e.len)) continue;
    const lo = e.ge ?? e.len;
    const hi = e.le ?? (e.ge !== null ? 32 : e.len);
    if (p.len >= lo && p.len <= hi) return e;
  }
  return null;
}
export const allows = (list: PfxEntry[], p: Prefix): boolean => decidingEntry(list, p)?.action === "permit";

// ---- BGP policy from a configuration --------------------------------------------------------------------------------------------

export function parseBgpPolicy(config: string): BgpPolicy {
  const pol: BgpPolicy = { localAs: null, networks: [], neighbors: new Map(), routeMaps: new Set(), routeMapPrefixLists: new Map() };
  let inBgp = false;
  let rm: string | null = null;
  const nb = (ip: string): NeighborPolicy => {
    let n = pol.neighbors.get(ip);
    if (!n) { n = { ip, remoteAs: null, prefixListIn: null, prefixListOut: null, routeMapIn: null, routeMapOut: null, lines: [] }; pol.neighbors.set(ip, n); }
    return n;
  };
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const as = /^router bgp\s+(\d+(?:\.\d+)?)/.exec(raw);
    if (as) { pol.localAs = as[1]; inBgp = true; rm = null; continue; }
    const m = /^route-map\s+(\S+)/.exec(raw);
    if (m) { pol.routeMaps.add(m[1]); rm = m[1]; inBgp = false; continue; }
    if (rm) {
      const ml = /^\s+match ip address prefix-list\s+(\S+)/.exec(raw);
      if (ml) pol.routeMapPrefixLists.set(rm, [...(pol.routeMapPrefixLists.get(rm) ?? []), ml[1]]);
    }
    if (/^\S/.test(raw) && !/^router bgp/.test(raw) && !/^route-map/.test(raw)) { if (!/^\s*!/.test(raw) && line !== "") { inBgp = false; rm = null; } continue; }
    if (!inBgp) continue;
    const net = /^network\s+(\d+\.\d+\.\d+\.\d+)(?:\s+mask\s+(\d+\.\d+\.\d+\.\d+))?/.exec(line);
    if (net) { pol.networks.push({ net: ip4(net[1]), len: net[2] ? plen(net[2]) : 24 }); continue; }
    const n = /^neighbor\s+(\d+\.\d+\.\d+\.\d+)\s+(.*)$/.exec(line);
    if (!n) continue;
    const p = nb(n[1]);
    p.lines.push(line);
    const ra = /^remote-as\s+(\S+)/.exec(n[2]);
    if (ra) p.remoteAs = ra[1];
    const pl = /^prefix-list\s+(\S+)\s+(in|out)/.exec(n[2]);
    if (pl) { if (pl[2] === "in") p.prefixListIn = pl[1]; else p.prefixListOut = pl[1]; }
    const r = /^route-map\s+(\S+)\s+(in|out)/.exec(n[2]);
    if (r) { if (r[2] === "in") p.routeMapIn = r[1]; else p.routeMapOut = r[1]; }
  }
  return pol;
}

// ---- the checks -----------------------------------------------------------------------------------------------------------------

export type BgpInput = { node: TopoNode; configText: string | null; bgpText?: string | null; brief: Map<string, { name: string; ip: string | null; status: string; protocol: string }> | null };
type MakeFinding = (f: Omit<Finding, "id">) => Finding;

const NAMED_AS_BLOCK = /(block|deny|drop|reject|bogon|filter)/i;
const range = (ps: Prefix[]) => (ps.length <= 3 ? ps.map(showPrefix).join(", ") : `${showPrefix(ps[0])} … ${showPrefix(ps[ps.length - 1])}`);

export function bgpPolicyFindings(inputs: BgpInput[], mk: MakeFinding): Finding[] {
  const out: Finding[] = [];
  const CFG = "show running-config", SUM = "show ip bgp summary";
  const ev = (label: string, cmd: string, line: string) => `${label}# ${cmd}: ${line.trim()}`;
  const base = (i: BgpInput) => ({ device: i.node.label, deviceId: i.node.id, interface: null as string | null, peer: null, linkId: null as string | null });

  const pol = new Map<string, BgpPolicy>();
  const lists = new Map<string, Map<string, PfxEntry[]>>();
  const peers = new Map<string, BgpPeer[]>();
  for (const i of inputs) {
    if (!i.configText) continue;
    pol.set(i.node.id, parseBgpPolicy(i.configText));
    lists.set(i.node.id, parsePrefixLists(i.configText));
    if (i.bgpText) peers.set(i.node.id, parseBgpSummary(i.bgpText));
  }
  const owners = new Map<string, BgpInput>();
  for (const i of inputs) for (const r of i.brief?.values() ?? []) if (r.ip && r.status !== "deleted") owners.set(r.ip, i);

  /** What the routers of an AS originate, de-duplicated, and how many of those routers were read. */
  const originated = (as: string): { prefixes: Prefix[]; routers: string[] } => {
    const seen = new Map<string, Prefix>();
    const routers: string[] = [];
    for (const i of inputs) {
      const p = pol.get(i.node.id);
      if (!p || p.localAs !== as) continue;
      routers.push(i.node.label);
      for (const n of p.networks) seen.set(showPrefix(n), n);
    }
    return { prefixes: [...seen.values()].sort((a, b) => a.net - b.net || a.len - b.len), routers };
  };

  for (const i of inputs) {
    const p = pol.get(i.node.id);
    const myLists = lists.get(i.node.id);
    if (!p || !myLists) continue;
    const label = i.node.label;

    // Filters that name something the configuration does not define.
    for (const n of p.neighbors.values()) {
      for (const [name, dir, kind] of [[n.prefixListIn, "in", "prefix-list"], [n.prefixListOut, "out", "prefix-list"], [n.routeMapIn, "in", "route-map"], [n.routeMapOut, "out", "route-map"]] as const) {
        if (!name) continue;
        const defined = kind === "prefix-list" ? myLists.has(name) : p.routeMaps.has(name);
        if (defined) continue;
        out.push(mk({ ...base(i), kind: "route-filter-undefined", severity: "warning", status: "confirmed", title: `${kind === "prefix-list" ? "Prefix-list" : "Route-map"} ${name} is used on neighbor ${n.ip} but is not defined`,
          description: `${label} applies ${kind} ${name} ${dir === "in" ? "to routes received from" : "to routes sent to"} ${n.ip}, and the running configuration has no ${kind} by that name. What an undefined ${kind} does differs between platforms and releases, so the filtering is not what it looks like.`,
          evidence: [ev(label, CFG, `neighbor ${n.ip} ${kind} ${name} ${dir}`), ev(label, CFG, `(no "${kind === "prefix-list" ? "ip prefix-list" : "route-map"} ${name}" line in the running configuration)`)],
          probableCause: "The name was mistyped, or the list was removed while the neighbor line stayed.", recommendedAction: `Define ${kind} ${name}, or remove it from the neighbor line.`, verification: `Confirmed from ${CFG} on ${label}.` }));
      }
    }

    // A filter that removes some of what the neighbour's AS originates, and whether the received count agrees.
    for (const n of p.neighbors.values()) {
      const remote = n.remoteAs;
      if (!remote || remote === p.localAs) continue; // iBGP: what a peer sends is not what it originates
      const list = n.prefixListIn ? myLists.get(n.prefixListIn) : undefined;
      if (!list || !n.prefixListIn) continue;
      const expected = originated(remote);
      if (!expected.prefixes.length) continue;
      const denied = expected.prefixes.filter((x) => !allows(list, x));
      if (!denied.length || denied.length === expected.prefixes.length) continue;
      const peer = peers.get(i.node.id)?.find((x) => x.neighbor === n.ip);
      const owner = owners.get(n.ip);
      const received = peer && peer.state === "Established" ? peer.prefixes : null;
      const matches = received !== null && received === expected.prefixes.length - denied.length;
      const rule = decidingEntry(list, denied[0])?.raw ?? "";
      out.push(mk({ ...base(i), kind: "route-filter-blocks-prefixes", severity: "warning", status: "confirmed", peer: owner ? { device: owner.node.label, deviceId: owner.node.id, interface: "" } : null,
        title: `Inbound prefix-list ${n.prefixListIn} on ${label} blocks ${denied.length} of the ${expected.prefixes.length} prefixes AS ${remote} originates`,
        description: `${label} filters routes from ${n.ip} (AS ${remote}) through prefix-list ${n.prefixListIn}. Evaluating its entries against the networks that ${expected.routers.join(" and ")} originate, ${denied.length} are denied (${range(denied)}). ${received !== null ? (matches ? `That is exactly why ${label} receives ${received} prefixes instead of ${expected.prefixes.length}.` : `${label} receives ${received} prefixes from ${n.ip}.`) : ""} If the filter is meant to hide them, nothing is wrong.`.replace(/\s+/g, " ").trim(),
        evidence: [ev(label, CFG, n.lines.find((l) => /prefix-list/.test(l)) ?? `neighbor ${n.ip} prefix-list ${n.prefixListIn} in`), ...(rule ? [ev(label, CFG, rule)] : []), ...(peer ? [ev(label, SUM, peer.raw)] : [])],
        probableCause: matches ? `${n.prefixListIn} denies ${denied.length} of the prefixes, which accounts for the whole difference.` : `${n.prefixListIn} denies prefixes that the neighbor's AS originates.`,
        recommendedAction: `Check that ${n.prefixListIn} is meant to remove ${range(denied)}. If not, change or remove the entry "${rule}".`,
        verification: `Worked out from the prefix-list entries and the network statements of ${expected.routers.join(", ")}${peer ? `, and checked against ${SUM} on ${label}` : ""}.` }));
    }

    // A neighbour that sends fewer prefixes than its AS originates, with nothing in the inbound prefix-list to explain it.
    for (const n of p.neighbors.values()) {
      const remote = n.remoteAs;
      if (!remote || remote === p.localAs) continue;
      const peer = peers.get(i.node.id)?.find((x) => x.neighbor === n.ip);
      if (!peer || peer.state !== "Established" || peer.prefixes === null) continue;
      const expected = originated(remote);
      if (!expected.prefixes.length) continue;
      const list = n.prefixListIn ? myLists.get(n.prefixListIn) : undefined;
      const blocked = list ? expected.prefixes.filter((x) => !allows(list, x)).length : 0;
      const shortfall = expected.prefixes.length - blocked - peer.prefixes;
      if (shortfall <= 0) continue; // nothing is missing, or the inbound filter accounts for all of it
      out.push(mk({ ...base(i), kind: "bgp-prefix-shortfall", severity: "warning", status: "suspected", title: `${label} receives ${peer.prefixes} prefixes from ${n.ip}, ${shortfall} fewer than expected`,
        description: `The routers of AS ${remote} that were read (${expected.routers.join(", ")}) originate ${expected.prefixes.length} prefixes, and nothing in ${label}'s inbound filter for ${n.ip} would remove ${blocked ? "any more than " + blocked : "any"}, yet ${n.ip} sends ${peer.prefixes}.`,
        evidence: [ev(label, SUM, peer.raw), `${expected.routers.join(", ")}# ${CFG}: ${expected.prefixes.length} distinct network statements in AS ${remote}`],
        probableCause: "The neighbor prefers another path for some prefixes and does not advertise them, an outbound filter or route-map on the neighbor removes them, or a router of that AS was not read.", recommendedAction: `On ${owners.get(n.ip)?.node.label ?? n.ip} check the outbound filters toward ${label} and run 'show ip bgp neighbors ${n.ip} advertised-routes'.`,
        verification: `Suspected: counts differ, but the cause is not visible in the configurations read. Confirm with 'show ip bgp neighbors ${n.ip} advertised-routes' on the neighbor.` }));
    }

    // A prefix-list that is named like a block list but only permits, and is used to match routes.
    for (const [name, entries] of myLists) {
      if (!NAMED_AS_BLOCK.test(name) || entries.some((e) => e.action === "deny")) continue;
      const usedBy = [...p.routeMapPrefixLists].filter(([, names]) => names.includes(name)).map(([rm]) => rm);
      const onNeighbor = [...p.neighbors.values()].filter((n) => n.prefixListIn === name || n.prefixListOut === name);
      if (!usedBy.length && !onNeighbor.length) continue;
      out.push(mk({ ...base(i), kind: "route-filter-name-misleading", severity: "info", status: "confirmed", title: `Prefix-list ${name} is named like a block list but only permits`,
        description: `${name} on ${label} has no deny entries, so it blocks nothing by itself${usedBy.length ? `; it is used to match routes in route-map ${usedBy.join(", ")}` : ""}. A name that says the opposite of what a list does invites a wrong change later.`,
        evidence: entries.slice(0, 3).map((e) => ev(label, CFG, e.raw)), probableCause: "The list was reused for a different purpose, or named for what an earlier version did.", recommendedAction: `Rename ${name} to say what it matches, or add the deny entries it was meant to have.`, verification: `Confirmed from ${CFG} on ${label}.` }));
    }
  }
  return out;
}
