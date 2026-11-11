import type { NodeKind } from "../cml/node-types";
import { buildTopology, cmlLinkStatus, type TopoLink, type TopoNode, type Topology } from "../cml/topology";
import type { DeviceRef, DeviceTransport, Inspectable, InventoryProvider, Platform, Scope } from "../core/types";
import type { Db } from "../database/db";
import { hostKeyStore } from "../database/repo";
import { normIf } from "../diagnostics/parsers";
import { getContext } from "../server/context";
import { SshTransport, type SshTarget } from "../transport/ssh";
import { type DiscoveryDef, type Inventory } from "./inventory-file";
import { circleLayout, targetFor } from "./static";

export type Neighbor = { name: string; address: string | null; localIf: string; remoteIf: string; platformText: string; capabilities: string; protocol: "cdp" | "lldp" };

const shortName = (n: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? n : n.split(".")[0]);

/** `show cdp neighbors detail`, IOS / NX-OS layout. Entries are separated by a row of dashes. */
export function parseCdpDetail(text: string): Neighbor[] {
  const out: Neighbor[] = [];
  for (const block of text.split(/^-{10,}\s*$/m)) {
    const id = block.match(/^Device ID:\s*(\S+)/m)?.[1];
    const intf = block.match(/^Interface:\s*([^,\s]+)\s*,\s*Port ID \(outgoing port\):\s*(\S+)/m);
    if (!id || !intf) continue;
    const ip = block.match(/IP(?:v4)? [Aa]ddress:\s*(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
    const plat = block.match(/^Platform:\s*(.*?),\s*Capabilities:\s*(.*)$/m);
    out.push({ name: shortName(id), address: ip, localIf: normIf(intf[1]), remoteIf: normIf(intf[2]), platformText: plat?.[1]?.trim() ?? "", capabilities: plat?.[2]?.trim() ?? "", protocol: "cdp" });
  }
  return out;
}

/** `show lldp neighbors detail`, in the IOS layout and in the EOS layout. */
export function parseLldpDetail(text: string): Neighbor[] {
  const out: Neighbor[] = [];
  if (/Interface\s+\S+\s+detected\s+\d+\s+LLDP neighbors?/i.test(text)) {
    for (const block of text.split(/^(?=Interface\s+\S+\s+detected)/m)) {
      const local = block.match(/^Interface\s+(\S+)\s+detected/m)?.[1];
      const port = block.match(/Port ID\s*:\s*"?([^"\n]+?)"?\s*$/m)?.[1];
      const name = block.match(/System Name:\s*"?([^"\n]+?)"?\s*$/m)?.[1];
      if (!local || !port || !name) continue;
      const ip = block.match(/Management Address\s*:\s*(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
      out.push({ name: shortName(name), address: ip, localIf: normIf(local), remoteIf: normIf(port), platformText: block.match(/System Description:\s*"?([^"\n]+)/)?.[1] ?? "", capabilities: block.match(/Enabled Capabilities\s*:\s*(.*)$/m)?.[1] ?? "", protocol: "lldp" });
    }
    return out;
  }
  for (const block of text.split(/^-{10,}\s*$/m)) {
    const local = block.match(/^Local Intf:\s*(\S+)/m)?.[1];
    const port = block.match(/^Port id:\s*(\S+)/m)?.[1];
    const name = block.match(/^System Name:\s*(\S+)/m)?.[1];
    if (!local || !port || !name) continue;
    const ip = block.match(/^\s*IP:\s*(\d+\.\d+\.\d+\.\d+)/m)?.[1] ?? null;
    out.push({ name: shortName(name), address: ip, localIf: normIf(local), remoteIf: normIf(port), platformText: block.match(/^System Description:\s*\n?(.*)$/m)?.[1]?.trim() ?? "", capabilities: block.match(/^Enabled Capabilities:\s*(.*)$/m)?.[1] ?? "", protocol: "lldp" });
  }
  return out;
}

export function guessPlatform(text: string, fallback: Platform): Platform {
  if (/arista|\beos\b/i.test(text)) return "eos";
  if (/nx-?os|nexus/i.test(text)) return "nxos";
  if (/junos|juniper/i.test(text)) return "junos";
  if (/cisco|ios/i.test(text)) return "ios";
  return fallback;
}

const FOLLOW = /router|switch|bridge|\bR\b|\bB\b|\bS\b/i;
const kindOf = (caps: string): NodeKind => (/router|\bR\b/i.test(caps) && /switch|bridge|\bS\b|\bB\b/i.test(caps) ? "l3switch" : /router|\bR\b/i.test(caps) ? "router" : /switch|bridge|\bS\b|\bB\b/i.test(caps) ? "l2switch" : "other");

export type DiscoveredDevice = { name: string; address: string | null; platform: Platform; kind: NodeKind; inspected: boolean; depth: number; note: string | null };
export type DiscoveredLink = { a: string; aInterface: string; b: string; bInterface: string; via: "cdp" | "lldp" };
export type DiscoveryResult = { at: string; devices: DiscoveredDevice[]; links: DiscoveredLink[]; warnings: string[] };

export type CrawlTransport = { run(d: DeviceRef, c: string): Promise<{ ok: boolean; text: string }> };

/**
 * Breadth-first crawl over neighbour tables. Bounded by depth and device count, and it follows only devices that
 * advertise themselves as a router or switch and have a management address. Read-only: it runs `show` commands only.
 */
export async function crawl(
  def: Pick<DiscoveryDef, "seeds" | "maxDevices" | "maxDepth">,
  transportFor: (address: string, platform: Platform, seedIndex: number) => CrawlTransport,
): Promise<DiscoveryResult> {
  const devices = new Map<string, DiscoveredDevice>();
  const links = new Map<string, DiscoveredLink>();
  const warnings: string[] = [];
  const byAddress = new Map<string, string>();
  type Item = { address: string; platform: Platform; depth: number; seed: number; hint: string | null };
  const queue: Item[] = def.seeds.map((s, i) => ({ address: s.address, platform: s.platform, depth: 0, seed: i, hint: null }));

  while (queue.length) {
    const it = queue.shift()!;
    if (byAddress.has(it.address)) continue;
    if (devices.size >= def.maxDevices) { warnings.push(`Stopped at ${def.maxDevices} devices; more may exist.`); break; }
    const t = transportFor(it.address, it.platform, it.seed);
    const ref: DeviceRef = { id: it.address, label: it.address, kind: "router", platform: it.platform };
    const host = await t.run(ref, "show running-config | include ^hostname");
    if (!host.ok) {
      byAddress.set(it.address, it.hint ?? it.address);
      devices.set(it.hint ?? it.address, { name: it.hint ?? it.address, address: it.address, platform: it.platform, kind: "other", inspected: false, depth: it.depth, note: host.text.slice(0, 160) });
      continue;
    }
    const name = shortName(host.text.match(/^hostname\s+(\S+)/m)?.[1] ?? it.hint ?? it.address);
    byAddress.set(it.address, name);
    const me: DiscoveredDevice = devices.get(name) ?? { name, address: it.address, platform: it.platform, kind: "other", inspected: true, depth: it.depth, note: null };
    me.address = it.address; me.inspected = true; me.platform = it.platform;
    devices.set(name, me);

    const found: Neighbor[] = [];
    const cdp = await t.run(ref, "show cdp neighbors detail");
    if (cdp.ok) found.push(...parseCdpDetail(cdp.text));
    const lldp = await t.run(ref, "show lldp neighbors detail");
    if (lldp.ok) found.push(...parseLldpDetail(lldp.text));
    if (!cdp.ok && !lldp.ok) warnings.push(`${name}: neither CDP nor LLDP output could be read, so its neighbours are unknown.`);

    for (const n of found) {
      const key = [`${name}|${n.localIf}`, `${n.name}|${n.remoteIf}`].sort().join("--");
      if (!links.has(key)) links.set(key, { a: name, aInterface: n.localIf, b: n.name, bInterface: n.remoteIf, via: n.protocol });
      const known = devices.get(n.name);
      const plat = guessPlatform(n.platformText, it.platform);
      if (!known) devices.set(n.name, { name: n.name, address: n.address, platform: plat, kind: kindOf(n.capabilities), inspected: false, depth: it.depth + 1, note: "Seen as a neighbour; not logged in to." });
      else {
        if (!known.address && n.address) known.address = n.address;
        if (known.kind === "other" && n.capabilities) known.kind = kindOf(n.capabilities); // what the neighbour says it is
      }
      if (!known?.inspected && n.address && FOLLOW.test(n.capabilities) && it.depth < def.maxDepth && !byAddress.has(n.address)) {
        queue.push({ address: n.address, platform: plat, depth: it.depth + 1, seed: it.seed, hint: n.name });
      }
    }
  }
  // A device we logged in to but nobody described is treated as a router; its kind only decides which checks apply.
  for (const d of devices.values()) if (d.inspected && d.kind === "other") d.kind = "router";
  return { at: new Date().toISOString(), devices: [...devices.values()], links: [...links.values()], warnings };
}

export function resultTopology(def: DiscoveryDef, r: DiscoveryResult): Topology {
  const id = `discovery:${def.id}`;
  const nodes: TopoNode[] = r.devices.map((d, i) => ({
    id: `${id}:${d.name}`, label: d.name, kind: d.kind, definition: d.platform, state: d.inspected ? "UNPROBED" : "NOT_LOGGED_IN", bootProgress: null,
    platform: d.platform, address: d.address ?? undefined, ...circleLayout(r.devices.length, i), interfaces: [],
  }));
  const byName = new Map(nodes.map((n) => [n.label, n]));
  const links: TopoLink[] = [];
  for (const l of r.links) {
    const a = byName.get(l.a), b = byName.get(l.b);
    if (!a || !b) continue;
    for (const [n, i] of [[a, l.aInterface], [b, l.bInterface]] as const) if (!n.interfaces.some((f) => f.label === i)) n.interfaces.push({ id: `${n.id}:${i}`, label: i, connected: true, ips: [] });
    links.push({ id: `${a.id}:${l.aInterface}--${b.id}:${l.bInterface}`, source: a.id, target: b.id, sourceInterface: l.aInterface, targetInterface: l.bInterface, cmlState: "DISCOVERED", status: cmlLinkStatus("STARTED").status, statusText: `Found by ${l.via.toUpperCase()}; traffic not inspected yet` });
  }
  const base = buildTopology({ id, title: def.title, state: "DISCOVERED", environment: def.environment, providerId: "discovery" }, [], [], new Map(), []);
  return { ...base, nodes, links, fetchedAt: r.at, warnings: r.warnings };
}

/** Networks found by crawling. Nothing exists until a crawl has been run for the definition. */
export class DiscoveryProvider implements InventoryProvider {
  readonly id = "discovery";
  readonly kind = "discovery" as const;
  readonly label = "Discovery";
  private transports = new Map<string, SshTransport>();

  constructor(private inventory: () => Inventory) {}

  private def(scopeId: string): DiscoveryDef {
    const d = this.inventory().discovery.find((x) => `discovery:${x.id}` === scopeId);
    if (!d) throw new Error(`There is no discovery definition "${scopeId.replace(/^discovery:/, "")}".`);
    return d;
  }

  private stored(db: Db, scopeId: string): DiscoveryResult | null {
    const row = db.prepare("SELECT data_json FROM discovery_results WHERE scope_id = ?").get(scopeId) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as DiscoveryResult) : null;
  }

  async listScopes(): Promise<Scope[]> {
    const db = getContext().db;
    return this.inventory().discovery.map((d) => {
      const r = this.stored(db, `discovery:${d.id}`);
      return { id: `discovery:${d.id}`, providerId: "discovery", providerKind: "discovery" as const, title: d.title, state: r ? "DISCOVERED" : "NOT_RUN", environment: d.environment, nodeCount: r?.devices.length ?? null, linkCount: r?.links.length ?? null, description: r ? `Last crawled ${r.at}` : "Not crawled yet. Run discovery to find devices and links.", owner: null };
    });
  }

  async getTopology(scopeId: string): Promise<Topology> {
    const d = this.def(scopeId);
    const r = this.stored(getContext().db, scopeId);
    if (!r) throw Object.assign(new Error("This network has not been discovered yet. Run discovery first."), { status: 409 });
    return resultTopology(d, r);
  }

  private transportFor(def: DiscoveryDef, address: string, platform: Platform, seed: number): SshTransport {
    const inv = this.inventory();
    const key = `${def.id}:${address}`;
    const cached = this.transports.get(key);
    if (cached) return cached;
    const jump = def.seeds[seed]?.jump;
    const target: SshTarget = targetFor(inv, { id: def.id, title: def.title, environment: def.environment, credential: def.credential, devices: [], links: [] }, { name: address, address, platform, jump, port: def.seeds[seed]?.port, transport: "ssh" });
    const t = new SshTransport(() => target, { hostKeys: hostKeyStore(getContext().db) });
    this.transports.set(key, t);
    return t;
  }

  async run(scopeId: string): Promise<DiscoveryResult> {
    const def = this.def(scopeId);
    const result = await crawl(def, (address, platform, seed) => this.transportFor(def, address, platform, seed));
    for (const t of this.transports.values()) t.closeAll();
    this.transports.clear();
    getContext().db.prepare("INSERT INTO discovery_results (scope_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").run(scopeId, JSON.stringify(result), result.at);
    return result;
  }

  transport(scopeId: string): DeviceTransport {
    const def = this.def(scopeId);
    const inv = this.inventory();
    const r = this.stored(getContext().db, scopeId);
    const t = new SshTransport((d: DeviceRef) => {
      const dev = r?.devices.find((x) => x.name === d.label);
      if (!dev?.address) return null;
      return targetFor(inv, { id: def.id, title: def.title, environment: def.environment, credential: def.credential, devices: [], links: [] }, { name: dev.name, address: dev.address, platform: dev.platform, transport: "ssh" });
    }, { hostKeys: hostKeyStore(getContext().db) });
    return t;
  }

  inspectable(n: TopoNode): Inspectable {
    return n.state === "NOT_LOGGED_IN" || !n.address ? { ok: false, reason: "Seen by discovery but not logged in to (no management address, or not a router/switch)." } : { ok: true };
  }
}
