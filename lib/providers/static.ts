import { statSync } from "node:fs";
import { buildTopology } from "../cml/topology";
import type { TopoLink, TopoNode, Topology } from "../cml/topology";
import { cmlLinkStatus } from "../cml/topology";
import type { DeviceRef, DeviceTransport, Inspectable, InventoryProvider, Scope } from "../core/types";
import { hostKeyStore } from "../database/repo";
import { getContext } from "../server/context";
import { CompositeTransport } from "../transport/composite";
import { EapiTransport } from "../transport/eapi";
import type { ApiTarget } from "../transport/http";
import { NetconfTransport } from "../transport/netconf";
import { NxapiTransport } from "../transport/nxapi";
import { SshTransport, type SshTarget } from "../transport/ssh";
import { type Inventory, type InventoryDevice, type InventorySite, defaultKind, loadInventoryFile } from "./inventory-file";

/** Lays devices out on a circle so a topology with no stored positions is readable until the engineer moves them. */
export function circleLayout(n: number, i: number): { x: number; y: number } {
  if (n === 1) return { x: 0, y: 0 };
  const r = Math.max(160, n * 38);
  const a = (2 * Math.PI * i) / n - Math.PI / 2;
  return { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) };
}

/** Builds the SSH target for one inventory device. Credentials stay references until the moment of connection. */
export function targetFor(inv: Inventory, site: InventorySite, d: InventoryDevice): SshTarget {
  const cred = inv.credentials[(d.credential ?? site.credential)!];
  const jumpDef = d.jump ? inv.jumpHosts[d.jump] : null;
  const jumpCred = jumpDef ? inv.credentials[jumpDef.credential] : null;
  return {
    label: d.name, host: d.address, port: d.port ?? (d.transport === "netconf" ? 830 : 22), username: cred.username,
    password: cred.password, privateKey: cred.privateKey, passphrase: cred.passphrase, enablePassword: cred.enablePassword, hostKey: d.hostKey,
    jump: jumpDef && jumpCred ? { label: `${d.jump} (jump host)`, host: jumpDef.address, port: jumpDef.port ?? 22, username: jumpCred.username, password: jumpCred.password, privateKey: jumpCred.privateKey, passphrase: jumpCred.passphrase, hostKey: jumpDef.hostKey } : undefined,
  };
}

/** The target for the HTTP-based transports (eapi, nxapi). The password stays a reference until a request is made. */
export function apiTargetFor(inv: Inventory, site: InventorySite, d: InventoryDevice): ApiTarget {
  const cred = inv.credentials[(d.credential ?? site.credential)!];
  return { label: d.name, host: d.address, port: d.port ?? 443, username: cred.username, password: cred.password ?? "", insecureTls: d.insecureTls, scheme: d.scheme };
}

/** One transport per way of reaching a device, with each device sent to the one its inventory entry names. */
export function buildTransport(inv: Inventory, site: InventorySite, hostKeys: ReturnType<typeof hostKeyStore>): CompositeTransport {
  const dev = (d: DeviceRef) => site.devices.find((x) => x.name === d.label);
  const ssh = new SshTransport((d) => { const x = dev(d); return x ? targetFor(inv, site, x) : null; }, { hostKeys });
  const netconf = new NetconfTransport((d) => { const x = dev(d); return x ? targetFor(inv, site, x) : null; }, { hostKeys });
  const eapi = new EapiTransport((d) => { const x = dev(d); return x ? apiTargetFor(inv, site, x) : null; });
  const nxapi = new NxapiTransport((d) => { const x = dev(d); return x ? apiTargetFor(inv, site, x) : null; });
  const byKind = { ssh, netconf, eapi, nxapi } as const;
  return new CompositeTransport((d) => byKind[dev(d)?.transport ?? "ssh"], () => [ssh, netconf]);
}

export function siteTopology(inv: Inventory, site: InventorySite, providerId: string): Topology {
  const nodes: TopoNode[] = site.devices.map((d, i) => ({
    id: `${providerId}:${site.id}:${d.name}`, label: d.name, kind: defaultKind(d), definition: d.platform, state: "UNPROBED", bootProgress: null,
    platform: d.platform, address: d.address, ...circleLayout(site.devices.length, i), interfaces: [],
  }));
  const byName = new Map(nodes.map((n) => [n.label, n]));
  const links: TopoLink[] = [];
  const seenIf = new Map<string, Set<string>>();
  for (const l of site.links) {
    const a = byName.get(l.a)!, b = byName.get(l.b)!;
    for (const [n, i] of [[a, l.aInterface], [b, l.bInterface]] as const) {
      if (!seenIf.has(n.id)) seenIf.set(n.id, new Set());
      if (!seenIf.get(n.id)!.has(i)) { seenIf.get(n.id)!.add(i); n.interfaces.push({ id: `${n.id}:${i}`, label: i, connected: true, ips: [] }); }
    }
    const s = cmlLinkStatus("STARTED");
    links.push({
      id: `${a.id}:${l.aInterface}--${b.id}:${l.bInterface}`, source: a.id, target: b.id, sourceInterface: l.aInterface, targetInterface: l.bInterface,
      cmlState: "DECLARED", status: s.status, statusText: "Declared in the inventory; traffic not inspected yet",
    });
  }
  const t = buildTopology({ id: `${providerId}:${site.id}`, title: site.title, state: "INVENTORY", environment: site.environment, providerId }, [], [], new Map(), []);
  return { ...t, nodes, links, warnings: site.links.length === 0 ? ["This site declares no links, so none are drawn. Run discovery to find them from CDP/LLDP neighbour tables."] : [] };
}

/** Devices and sites from a YAML/JSON file. Real gear, reached over SSH. */
export class StaticProvider implements InventoryProvider {
  readonly kind = "static" as const;
  readonly label: string;
  private cache: { mtimeMs: number; inv: Inventory } | null = null;
  private transports = new Map<string, CompositeTransport>();

  constructor(readonly path: string, readonly id = "static") {
    this.label = `Inventory file`;
  }

  inventory(): Inventory {
    const mtimeMs = statSync(this.path).mtimeMs;
    if (!this.cache || this.cache.mtimeMs !== mtimeMs) { this.cache = { mtimeMs, inv: loadInventoryFile(this.path) }; this.transports.clear(); }
    return this.cache.inv;
  }

  private site(scopeId: string): { inv: Inventory; site: InventorySite } {
    const inv = this.inventory();
    const local = scopeId.slice(this.id.length + 1);
    const site = inv.sites.find((s) => s.id === local);
    if (!site) throw new Error(`The inventory has no site "${local}".`);
    return { inv, site };
  }

  async listScopes(): Promise<Scope[]> {
    return this.inventory().sites.map((s) => ({
      id: `${this.id}:${s.id}`, providerId: this.id, providerKind: "static" as const, title: s.title, state: "INVENTORY", environment: s.environment,
      nodeCount: s.devices.length, linkCount: s.links.length, description: s.description ?? "", owner: null,
    }));
  }

  async getTopology(scopeId: string): Promise<Topology> {
    const { inv, site } = this.site(scopeId);
    return siteTopology(inv, site, this.id);
  }

  transport(scopeId: string): DeviceTransport {
    const { inv, site } = this.site(scopeId);
    const hit = this.transports.get(scopeId);
    if (hit) return hit;
    const t = buildTransport(inv, site, hostKeyStore(getContext().db));
    this.transports.set(scopeId, t);
    return t;
  }

  inspectable(n: TopoNode): Inspectable {
    return n.address ? { ok: true } : { ok: false, reason: "No management address." };
  }
}
