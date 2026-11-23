import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type NodeKind } from "../cml/node-types";
import { PLATFORMS, type Environment, type Platform } from "../core/types";
import { isSecretRef } from "../core/secrets";

/**
 * The static inventory file (YAML or JSON). It lists sites, devices and, optionally, links. Passwords and keys are
 * never written in it; they are references (`env:NAME`, `file:/path`) that are resolved when a device is contacted.
 */
const ref = z.string().refine(isSecretRef, "must be env:NAME or file:/path; secrets are never written into the inventory");

const credential = z.strictObject({
  username: z.string().min(1),
  password: ref.optional(),
  privateKey: ref.optional(),
  passphrase: ref.optional(),
  enablePassword: ref.optional(),
}).refine((c) => c.password || c.privateKey, "needs a password or privateKey reference");

const kind = z.enum(["router", "l2switch", "l3switch", "firewall", "server", "host", "other"]);
const platform = z.enum(PLATFORMS as [Platform, ...Platform[]]);
const environment = z.enum(["lab", "production"]);
const hostKey = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, "must look like SHA256:<base64 fingerprint>");

const device = z.strictObject({
  name: z.string().min(1),
  address: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  platform,
  kind: kind.optional(),
  credential: z.string().optional(),
  jump: z.string().optional(),
  hostKey: hostKey.optional(),
  /** How the device is reached. ssh is the default; the others are for platforms whose changes need an API. */
  transport: z.enum(["ssh", "netconf", "eapi", "nxapi"]).default("ssh"),
  /** eapi / nxapi only. https is the default; http is accepted only for a loopback address. */
  scheme: z.enum(["https", "http"]).optional(),
  /** eapi / nxapi only. Certificates are verified unless this is set. */
  insecureTls: z.boolean().optional(),
});

const link = z.strictObject({ a: z.string(), aInterface: z.string(), b: z.string(), bInterface: z.string() });

const site = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, dot, dash or underscore"),
  title: z.string().min(1),
  description: z.string().optional(),
  environment,
  credential: z.string().optional(),
  devices: z.array(device).min(1),
  links: z.array(link).default([]),
});

/** A crawl: start at the seeds and follow CDP/LLDP neighbours, never further than the caps. Uses the seeds' credential. */
const discovery = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, dot, dash or underscore"),
  title: z.string().min(1),
  environment,
  credential: z.string(),
  seeds: z.array(z.strictObject({ address: z.string().min(1), platform, port: z.number().int().min(1).max(65535).optional(), jump: z.string().optional() })).min(1),
  maxDevices: z.number().int().min(1).max(200).default(30),
  maxDepth: z.number().int().min(0).max(8).default(3),
});

export const inventorySchema = z.strictObject({
  credentials: z.record(z.string(), credential).default({}),
  jumpHosts: z.record(z.string(), z.strictObject({ address: z.string(), port: z.number().int().optional(), credential: z.string(), hostKey: hostKey.optional() })).default({}),
  sites: z.array(site).default([]),
  discovery: z.array(discovery).default([]),
}).refine((i) => i.sites.length + i.discovery.length > 0, "needs at least one site or discovery definition");

export type DiscoveryDef = z.infer<typeof discovery>;

export type Inventory = z.infer<typeof inventorySchema>;
export type InventorySite = Inventory["sites"][number];
export type InventoryDevice = z.infer<typeof device>;
export type InventoryCredential = z.infer<typeof credential>;

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export function defaultKind(d: InventoryDevice): NodeKind {
  return d.kind ?? (d.platform === "unknown" ? "other" : "router");
}

/** Parses and cross-checks an inventory. Every problem names the place it is in. */
export function parseInventory(text: string): Inventory {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new InventoryError(`The inventory is not valid YAML or JSON: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }
  const r = inventorySchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new InventoryError(`Inventory problem at ${i.path.join(".") || "(top level)"}: ${i.message}`);
  }
  const inv = r.data;
  const seen = new Set<string>();
  for (const s of inv.sites) {
    if (seen.has(s.id)) throw new InventoryError(`Site id "${s.id}" appears twice.`);
    seen.add(s.id);
    const names = new Set<string>();
    for (const d of s.devices) {
      if (names.has(d.name)) throw new InventoryError(`Device "${d.name}" appears twice in site "${s.id}".`);
      names.add(d.name);
      const cred = d.credential ?? s.credential;
      if (!cred) throw new InventoryError(`Device "${d.name}" in site "${s.id}" has no credential: set one on the device or the site.`);
      if (!inv.credentials[cred]) throw new InventoryError(`Device "${d.name}" uses credential "${cred}", which is not defined.`);
      const want = { netconf: "junos", eapi: "eos", nxapi: "nxos" } as const;
      if (d.transport !== "ssh" && d.platform !== want[d.transport]) throw new InventoryError(`Device "${d.name}": transport ${d.transport} is for ${want[d.transport]} devices, not ${d.platform}.`);
      if ((d.transport === "eapi" || d.transport === "nxapi") && !inv.credentials[cred].password) throw new InventoryError(`Device "${d.name}": transport ${d.transport} needs a credential with a password reference.`);
      if ((d.scheme || d.insecureTls !== undefined) && d.transport !== "eapi" && d.transport !== "nxapi") throw new InventoryError(`Device "${d.name}": scheme and insecureTls apply to the eapi and nxapi transports only.`);
      if (d.scheme === "http" && !/^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(d.address)) throw new InventoryError(`Device "${d.name}": plain http is only allowed to a local address; use https.`);
      if (d.jump && !inv.jumpHosts[d.jump]) throw new InventoryError(`Device "${d.name}" uses jump host "${d.jump}", which is not defined.`);
    }
    for (const l of s.links) {
      for (const end of [l.a, l.b]) if (!names.has(end)) throw new InventoryError(`A link in site "${s.id}" refers to "${end}", which is not a device in that site.`);
    }
  }
  for (const d of inv.discovery) {
    if (seen.has(`discovery:${d.id}`)) throw new InventoryError(`Discovery id "${d.id}" appears twice.`);
    seen.add(`discovery:${d.id}`);
    if (!inv.credentials[d.credential]) throw new InventoryError(`Discovery "${d.id}" uses credential "${d.credential}", which is not defined.`);
    for (const s of d.seeds) if (s.jump && !inv.jumpHosts[s.jump]) throw new InventoryError(`Discovery "${d.id}" uses jump host "${s.jump}", which is not defined.`);
  }
  for (const [name, j] of Object.entries(inv.jumpHosts)) {
    if (!inv.credentials[j.credential]) throw new InventoryError(`Jump host "${name}" uses credential "${j.credential}", which is not defined.`);
  }
  return inv;
}

export function loadInventoryFile(path: string): Inventory {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InventoryError(`The inventory file ${path} could not be read.`);
  }
  return parseInventory(text);
}

export type { Environment };
