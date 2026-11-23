import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { isSecretRef } from "../core/secrets";
import { type Inventory, InventoryError, validateInventory } from "./inventory-file";

/**
 * Reads an Ansible inventory (YAML, JSON or INI) and turns it into a Tiny Snitch inventory, so a team that already
 * keeps its devices in Ansible does not have to describe them twice.
 *
 * What is taken: hosts, groups and their variable inheritance, `ansible_host`, `ansible_port`, `ansible_network_os`,
 * `ansible_connection`, `ansible_user`, and an `ansible_ssh_private_key_file` path.
 * What is NEVER taken: passwords. `ansible_password`, `ansible_ssh_pass`, `ansible_become_password` and vault-encrypted
 * values are ignored on purpose. A password is a reference (`tiny_snitch_password: env:NAME`) or, by default,
 * the environment variable TS_ANSIBLE_PASSWORD, so no secret is ever read out of an inventory file.
 *
 * Extra variables Tiny Snitch understands: tiny_snitch_environment (lab | production, default production),
 * tiny_snitch_kind, tiny_snitch_password, tiny_snitch_enable_password, tiny_snitch_host_key, tiny_snitch_links.
 */
export type Vars = Record<string, unknown>;
type Group = { name: string; hosts: Map<string, Vars>; vars: Vars; children: Set<string> };
export type AnsibleResult = { inventory: Inventory; warnings: string[] };

const VAULT = "[vault-encrypted value ignored]";

function newGroup(name: string): Group {
  return { name, hosts: new Map(), vars: {}, children: new Set() };
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function walk(name: string, node: unknown, groups: Map<string, Group>): void {
  const g = groups.get(name) ?? newGroup(name);
  groups.set(name, g);
  const n = asObj(node);
  Object.assign(g.vars, asObj(n.vars));
  for (const [h, v] of Object.entries(asObj(n.hosts))) g.hosts.set(h, { ...(g.hosts.get(h) ?? {}), ...asObj(v) });
  for (const [c, cn] of Object.entries(asObj(n.children))) { g.children.add(c); walk(c, cn, groups); }
}

export function parseYamlInventory(text: string): Map<string, Group> {
  let raw: unknown;
  try {
    raw = parseYaml(text, { customTags: [{ tag: "!vault", resolve: () => VAULT }, { tag: "!unsafe", resolve: (s: string) => s }] });
  } catch (e) {
    throw new InventoryError(`The Ansible inventory is not valid YAML or JSON: ${e instanceof Error ? e.message.split("\n")[0] : "parse error"}`);
  }
  const root = asObj(raw);
  const groups = new Map<string, Group>([["all", newGroup("all")]]);
  for (const [key, node] of Object.entries(root)) {
    walk(key, node, groups);
    if (key !== "all") groups.get("all")!.children.add(key);
  }
  return groups;
}

function coerce(v: string): unknown {
  const s = v.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/** `name key=value key2="two words"` */
function kv(text: string): Vars {
  const out: Vars = {};
  for (const m of text.matchAll(/(\w+)=("[^"]*"|'[^']*'|\S+)/g)) out[m[1]] = coerce(m[2]);
  return out;
}

export function parseIniInventory(text: string): Map<string, Group> {
  const groups = new Map<string, Group>([["all", newGroup("all")], ["ungrouped", newGroup("ungrouped")]]);
  let section = "ungrouped";
  let kind: "hosts" | "children" | "vars" = "hosts";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+[#;].*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[([^\]:]+)(?::(children|vars))?\]$/);
    if (sec) {
      section = sec[1];
      kind = (sec[2] as "children" | "vars" | undefined) ?? "hosts";
      if (!groups.has(section)) groups.set(section, newGroup(section));
      continue;
    }
    const g = groups.get(section)!;
    if (kind === "vars") Object.assign(g.vars, kv(line));
    else if (kind === "children") { g.children.add(line); if (!groups.has(line)) groups.set(line, newGroup(line)); }
    else { const [name, ...rest] = line.split(/\s+/); g.hosts.set(name, { ...(g.hosts.get(name) ?? {}), ...kv(rest.join(" ")) }); }
  }
  // Every group that is nobody's child hangs off `all`, as Ansible does.
  const childOf = new Set([...groups.values()].flatMap((g) => [...g.children]));
  for (const g of groups.values()) if (g.name !== "all" && !childOf.has(g.name)) groups.get("all")!.children.add(g.name);
  return groups;
}

function looksLikeIni(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("---")) return false;
  return /^\s*\[[^\]]+\]\s*$/m.test(text) && !/^\s*(all|[\w.-]+):\s*$/m.test(text);
}

const depthFromAll = (groups: Map<string, Group>): Map<string, number> => {
  const depth = new Map<string, number>([["all", 0]]);
  const queue = ["all"];
  while (queue.length) {
    const n = queue.shift()!;
    for (const c of groups.get(n)?.children ?? []) if (!depth.has(c)) { depth.set(c, depth.get(n)! + 1); queue.push(c); }
  }
  return depth;
};

/** Every host under a group, directly or through child groups. */
function hostsUnder(groups: Map<string, Group>, name: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  seen.add(name);
  const g = groups.get(name);
  if (!g) return out;
  for (const h of g.hosts.keys()) out.add(h);
  for (const c of g.children) for (const h of hostsUnder(groups, c, seen)) out.add(h);
  return out;
}

/** Host variables with Ansible's inheritance: all, then groups from shallow to deep, then the host itself. */
function effectiveVars(groups: Map<string, Group>, depth: Map<string, number>, host: string): Vars {
  const member = [...groups.values()].filter((g) => hostsUnder(groups, g.name).has(host)).sort((a, b) => (depth.get(a.name) ?? 99) - (depth.get(b.name) ?? 99) || a.name.localeCompare(b.name));
  const vars: Vars = {};
  for (const g of member) Object.assign(vars, g.vars);
  for (const g of groups.values()) if (g.hosts.has(host)) Object.assign(vars, g.hosts.get(host));
  return vars;
}

const NETWORK_OS: Record<string, "ios" | "nxos" | "eos" | "junos"> = { ios: "ios", iosxe: "ios", nxos: "nxos", eos: "eos", junos: "junos" };
const SECRET_VARS = ["ansible_password", "ansible_ssh_pass", "ansible_become_password", "ansible_httpapi_pass"];
const KINDS = new Set(["router", "l2switch", "l3switch", "firewall", "server", "host", "other"]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v !== VAULT ? v.trim() : typeof v === "number" ? String(v) : undefined);
const last = (s: string) => s.toLowerCase().split(".").pop() ?? "";
const siteId = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_") || "site";

export function convertAnsible(groups: Map<string, Group>): AnsibleResult {
  const warnings: string[] = [];
  const depth = depthFromAll(groups);
  const all = groups.get("all")!;

  // Sites: each top-level group is a network. Hosts that belong to no group go in "ungrouped".
  const topGroups = [...all.children].filter((c) => groups.has(c));
  const grouped = new Set(topGroups.flatMap((c) => [...hostsUnder(groups, c)]));
  const loose = [...hostsUnder(groups, "all")].filter((h) => !grouped.has(h));
  const siteDefs: { id: string; title: string; group: string | null; hosts: string[] }[] = topGroups.map((c) => ({ id: siteId(c), title: c, group: c, hosts: [...hostsUnder(groups, c)] }));
  if (loose.length) siteDefs.push({ id: topGroups.length ? "ungrouped" : "all", title: topGroups.length ? "ungrouped" : "all", group: null, hosts: loose });

  const creds = new Map<string, { name: string; value: { username: string; password?: string; privateKey?: string; enablePassword?: string } }>();
  const credFor = (value: { username: string; password?: string; privateKey?: string; enablePassword?: string }): string => {
    const key = JSON.stringify(value);
    if (!creds.has(key)) creds.set(key, { name: `ansible-${creds.size + 1}`, value });
    return creds.get(key)!.name;
  };

  const ignoredSecrets = new Set<string>();
  const used = new Set<string>();
  const sites: unknown[] = [];

  for (const def of siteDefs) {
    let id = def.id;
    for (let n = 2; used.has(id); n++) id = `${def.id}_${n}`;
    used.add(id);
    // A site is a top-level group, so its settings are `all` plus that group's own variables.
    const siteVars: Vars = { ...all.vars, ...(def.group ? groups.get(def.group)?.vars ?? {} : {}) };
    let environment = str(siteVars.tiny_snitch_environment) ?? "production";
    if (environment !== "lab" && environment !== "production") { warnings.push(`${def.title}: tiny_snitch_environment must be lab or production, not "${environment}"; treating it as production.`); environment = "production"; }

    const devices: Record<string, unknown>[] = [];
    for (const host of def.hosts) {
      const v = effectiveVars(groups, depth, host);
      const skip = (why: string) => warnings.push(`${host}: skipped (${why}).`);
      for (const s of SECRET_VARS) if (v[s] !== undefined) ignoredSecrets.add(s);

      const os = str(v.ansible_network_os);
      if (!os) { skip("no ansible_network_os, so it is not a network device Tiny Snitch can read"); continue; }
      const platform = NETWORK_OS[last(os)];
      if (!platform) { skip(`ansible_network_os "${os}" is not supported`); continue; }

      const conn = last(str(v.ansible_connection) ?? "network_cli");
      let transport: "ssh" | "netconf" | "eapi" | "nxapi";
      if (conn === "network_cli" || conn === "ssh" || conn === "paramiko_ssh") transport = "ssh";
      else if (conn === "netconf") { if (platform !== "junos") { skip("netconf is only supported for Junos"); continue; } transport = "netconf"; }
      else if (conn === "httpapi") { if (platform === "eos") transport = "eapi"; else if (platform === "nxos") transport = "nxapi"; else { skip(`httpapi is not supported for ${platform}; use network_cli`); continue; } }
      else { skip(`ansible_connection "${conn}" is not supported`); continue; }

      const username = str(v.ansible_user) ?? str(v.ansible_ssh_user);
      if (!username) { skip("no ansible_user"); continue; }

      const refVar = str(v.tiny_snitch_password);
      if (refVar && !isSecretRef(refVar)) { skip("tiny_snitch_password must be env:NAME or file:/path, never a password"); continue; }
      const keyFile = str(v.ansible_ssh_private_key_file) ?? str(v.ansible_private_key_file);
      const needsPassword = transport === "eapi" || transport === "nxapi";
      const password = refVar ?? (needsPassword || !keyFile ? "env:TS_ANSIBLE_PASSWORD" : undefined);
      const enable = str(v.tiny_snitch_enable_password);
      if (enable && !isSecretRef(enable)) { skip("tiny_snitch_enable_password must be env:NAME or file:/path"); continue; }
      if (str(v.ansible_ssh_common_args)?.match(/ProxyJump|ProxyCommand/i)) warnings.push(`${host}: ProxyJump/ProxyCommand in ansible_ssh_common_args is not imported; define a jump host in a Tiny Snitch inventory instead.`);

      const kindVar = str(v.tiny_snitch_kind);
      if (kindVar && !KINDS.has(kindVar)) warnings.push(`${host}: tiny_snitch_kind "${kindVar}" is not a known kind; using router.`);
      const dev: Record<string, unknown> = {
        name: host, address: str(v.ansible_host) ?? host, platform, kind: kindVar && KINDS.has(kindVar) ? kindVar : "router", transport,
        credential: credFor({ username, password, privateKey: keyFile ? `file:${keyFile}` : undefined, enablePassword: enable }),
      };
      const port = Number(v.ansible_port ?? (transport === "eapi" || transport === "nxapi" ? v.ansible_httpapi_port : undefined));
      if (Number.isInteger(port) && port > 0) dev.port = port;
      if (str(v.tiny_snitch_host_key)) dev.hostKey = str(v.tiny_snitch_host_key);
      if (transport === "eapi" || transport === "nxapi") {
        if (v.ansible_httpapi_use_ssl === false) warnings.push(`${host}: ansible_httpapi_use_ssl is false; plain http is not supported, so https is used.`);
        if (v.ansible_httpapi_validate_certs === false) { dev.insecureTls = true; warnings.push(`${host}: ansible_httpapi_validate_certs is false, so TLS certificate checks are off for this device.`); }
      }
      devices.push(dev);
    }
    if (!devices.length) { warnings.push(`${def.title}: no usable network devices, so it is not listed.`); continue; }
    const names = new Set(devices.map((d) => d.name));
    const rawLinks = Array.isArray(siteVars.tiny_snitch_links) ? (siteVars.tiny_snitch_links as unknown[]) : [];
    const links = rawLinks.map(asObj).filter((l) => names.has(l.a) && names.has(l.b) && typeof l.aInterface === "string" && typeof l.bInterface === "string");
    if (rawLinks.length !== links.length) warnings.push(`${def.title}: ${rawLinks.length - links.length} entr${rawLinks.length - links.length === 1 ? "y" : "ies"} in tiny_snitch_links did not name devices in this group and were ignored.`);
    sites.push({ id, title: def.title, environment, devices, links });
  }

  if (ignoredSecrets.size) warnings.push(`Ignored ${[...ignoredSecrets].sort().join(", ")}: passwords are never read from an inventory. Set tiny_snitch_password to env:NAME or file:/path, or set TS_ANSIBLE_PASSWORD.`);
  if (!sites.length) throw new InventoryError("The Ansible inventory has no network devices Tiny Snitch can use (each needs ansible_network_os, ansible_user and a supported connection).");

  const credentials: Record<string, unknown> = {};
  for (const { name, value } of creds.values()) credentials[name] = Object.fromEntries(Object.entries(value).filter(([, x]) => x !== undefined));
  return { inventory: validateInventory({ credentials, sites }), warnings };
}

export function parseAnsibleInventory(text: string): AnsibleResult {
  return convertAnsible(looksLikeIni(text) ? parseIniInventory(text) : parseYamlInventory(text));
}

export function loadAnsibleInventory(path: string): AnsibleResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InventoryError(`The Ansible inventory ${path} could not be read.`);
  }
  return parseAnsibleInventory(text);
}
