import { cmlLinkStatus, buildTopology } from "../cml/topology";
import type { NodeKind } from "../cml/node-types";
import type { TopoLink, TopoNode, Topology } from "../cml/topology";
import type { DeviceRef, DeviceTransport, Environment, Inspectable, InventoryProvider, Platform, Scope } from "../core/types";
import { hostKeyStore } from "../database/repo";
import { getContext } from "../server/context";
import { SshTransport, type SshTarget } from "../transport/ssh";
import { circleLayout } from "./static";

/**
 * NetBox as the source of truth: its sites are the networks, its devices and cables are the topology. NetBox does
 * not hold credentials, so SSH access comes from the environment (NETBOX_SSH_USERNAME plus NETBOX_SSH_PASSWORD or
 * NETBOX_SSH_KEY_FILE). A site is treated as production unless it carries the tag "lab", so a mistake errs safe.
 */
export type NetboxConfig = {
  url: string;
  token: string;
  username: string;
  password?: string;   // secret reference, e.g. env:NETBOX_SSH_PASSWORD
  privateKey?: string; // secret reference, e.g. file:/home/me/.ssh/id_ed25519
  defaultEnvironment: Environment;
};

type Fetch = typeof fetch;
type Page<T> = { results: T[]; next: string | null };

export class NetboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetboxError";
  }
}

export function platformFromSlug(slug: string | null | undefined): Platform {
  const s = (slug ?? "").toLowerCase();
  if (/(^|[-_])(nx-?os|nexus)/.test(s)) return "nxos";
  if (/(^|[-_])(eos|arista)/.test(s)) return "eos";
  if (/junos|juniper/.test(s)) return "junos";
  if (/(^|[-_])(ios|ios-?xe|iosxe|cisco)/.test(s)) return "ios";
  return "unknown";
}

export function kindFromRole(slug: string | null | undefined, platform: Platform): NodeKind {
  const s = (slug ?? "").toLowerCase();
  if (/firewall/.test(s)) return "firewall";
  if (/(l3|layer-?3|core|distribution).*switch|switch.*(l3|core)/.test(s)) return "l3switch";
  if (/switch|access/.test(s)) return "l2switch";
  if (/router|gateway|edge|pe|ce|border/.test(s)) return "router";
  return platform === "unknown" ? "other" : "router";
}

type NbSite = { id: number; name: string; slug: string; description?: string; tags?: { slug: string }[]; device_count?: number };
type NbDevice = { id: number; name: string | null; role?: { slug: string } | null; device_role?: { slug: string } | null; platform?: { slug: string } | null; primary_ip?: { address: string } | null; primary_ip4?: { address: string } | null };
type NbEnd = { object?: { name?: string; device?: { name?: string } | null } | null };
type NbCable = { id: number; a_terminations?: NbEnd[]; b_terminations?: NbEnd[] };

export class NetboxProvider implements InventoryProvider {
  readonly id = "netbox";
  readonly kind = "netbox" as const;
  readonly label = "NetBox";
  private transports = new Map<string, SshTransport>();
  private cache = new Map<string, { at: number; value: Topology; targets: Map<string, SshTarget> }>();

  constructor(private cfg: NetboxConfig, private http: Fetch = fetch, private ttlMs = 30_000) {}

  private async get<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.cfg.url.replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}limit=500`;
    for (let guard = 0; url && guard < 50; guard++) {
      let res: Response;
      try {
        res = await this.http(url, { headers: { Authorization: `Token ${this.cfg.token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        throw new NetboxError(`NetBox could not be reached at ${this.cfg.url}: ${e instanceof Error ? e.message.slice(0, 120) : "network error"}`);
      }
      if (res.status === 401 || res.status === 403) throw new NetboxError("NetBox refused the API token (check NETBOX_TOKEN and its permissions).");
      if (!res.ok) throw new NetboxError(`NetBox answered ${res.status} for ${path.split("?")[0]}.`);
      const page = (await res.json()) as Page<T>;
      out.push(...page.results);
      url = page.next ? new URL(page.next, this.cfg.url).toString() : null;
    }
    return out;
  }

  private env(s: NbSite): Environment {
    const tags = (s.tags ?? []).map((t) => t.slug);
    if (tags.includes("production")) return "production";
    if (tags.includes("lab")) return "lab";
    return this.cfg.defaultEnvironment;
  }

  async listScopes(): Promise<Scope[]> {
    const sites = await this.get<NbSite>("/api/dcim/sites/");
    return sites.map((s) => ({
      id: `netbox:${s.slug}`, providerId: "netbox", providerKind: "netbox" as const, title: s.name, state: "INVENTORY", environment: this.env(s),
      nodeCount: s.device_count ?? null, linkCount: null, description: s.description ?? "", owner: null,
    }));
  }

  async getTopology(scopeId: string, refresh = false): Promise<Topology> {
    const hit = this.cache.get(scopeId);
    if (!refresh && hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const slug = scopeId.slice("netbox:".length);
    const site = (await this.get<NbSite>(`/api/dcim/sites/?slug=${encodeURIComponent(slug)}`))[0];
    if (!site) throw new NetboxError(`NetBox has no site "${slug}".`);
    const devices = (await this.get<NbDevice>(`/api/dcim/devices/?site_id=${site.id}`)).filter((d) => d.name);
    const cables = await this.get<NbCable>(`/api/dcim/cables/?site_id=${site.id}`);

    const targets = new Map<string, SshTarget>();
    const nodes: TopoNode[] = devices.map((d, i) => {
      const platform = platformFromSlug(d.platform?.slug);
      const ip = (d.primary_ip4 ?? d.primary_ip)?.address?.split("/")[0];
      const name = d.name!;
      if (ip && this.cfg.username) targets.set(name, { label: name, host: ip, port: 22, username: this.cfg.username, password: this.cfg.password, privateKey: this.cfg.privateKey });
      return {
        id: `netbox:${slug}:${name}`, label: name, kind: kindFromRole((d.role ?? d.device_role)?.slug, platform), definition: d.platform?.slug ?? "", state: "UNPROBED", bootProgress: null,
        platform, address: ip, ...circleLayout(devices.length, i), interfaces: [],
      };
    });
    const byName = new Map(nodes.map((n) => [n.label, n]));
    const links: TopoLink[] = [];
    const warnings: string[] = [];
    for (const c of cables) {
      const a = c.a_terminations?.[0]?.object, b = c.b_terminations?.[0]?.object;
      const an = a?.device?.name, bn = b?.device?.name;
      if (!an || !bn || !a?.name || !b?.name) continue; // circuit or power cables have no device on both ends
      const x = byName.get(an), y = byName.get(bn);
      if (!x || !y) { warnings.push(`A cable to a device outside this site was left out.`); continue; }
      for (const [n, i] of [[x, a.name], [y, b.name]] as const) if (!n.interfaces.some((f) => f.label === i)) n.interfaces.push({ id: `${n.id}:${i}`, label: i, connected: true, ips: [] });
      const s = cmlLinkStatus("STARTED");
      links.push({ id: `netbox-cable-${c.id}`, source: x.id, target: y.id, sourceInterface: a.name, targetInterface: b.name, cmlState: "DECLARED", status: s.status, statusText: "Recorded in NetBox; traffic not inspected yet" });
    }
    if (!links.length) warnings.push("NetBox has no cables recorded between devices in this site, so none are drawn.");
    const noAddr = nodes.filter((n) => !n.address).length;
    if (noAddr) warnings.push(`${noAddr} device(s) have no primary IP in NetBox and cannot be reached.`);
    const base = buildTopology({ id: scopeId, title: site.name, state: "INVENTORY", environment: this.env(site), providerId: "netbox" }, [], [], new Map(), []);
    const value: Topology = { ...base, nodes, links, warnings };
    this.cache.set(scopeId, { at: Date.now(), value, targets });
    return value;
  }

  transport(scopeId: string): DeviceTransport {
    const hit = this.transports.get(scopeId);
    if (hit) return hit;
    const t = new SshTransport((d: DeviceRef) => this.cache.get(scopeId)?.targets.get(d.label) ?? null, { hostKeys: hostKeyStore(getContext().db) });
    this.transports.set(scopeId, t);
    return t;
  }

  inspectable(n: TopoNode): Inspectable {
    if (!n.address) return { ok: false, reason: "NetBox has no primary IP for this device." };
    if (!this.cfg.username) return { ok: false, reason: "No SSH username is configured (NETBOX_SSH_USERNAME)." };
    return { ok: true };
  }
}

export function loadNetboxConfig(env: NodeJS.ProcessEnv = process.env): NetboxConfig | null {
  const url = env.NETBOX_URL?.trim();
  if (!url) return null;
  const token = env.NETBOX_TOKEN?.trim();
  if (!token) throw new NetboxError("NETBOX_URL is set but NETBOX_TOKEN is not.");
  const keyFile = env.NETBOX_SSH_KEY_FILE?.trim();
  return {
    url, token, username: env.NETBOX_SSH_USERNAME?.trim() ?? "",
    password: env.NETBOX_SSH_PASSWORD ? "env:NETBOX_SSH_PASSWORD" : undefined,
    privateKey: keyFile ? `file:${keyFile}` : undefined,
    defaultEnvironment: env.NETBOX_DEFAULT_ENVIRONMENT === "lab" ? "lab" : "production",
  };
}
