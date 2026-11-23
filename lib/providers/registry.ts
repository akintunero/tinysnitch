import type { InventoryProvider } from "../core/types";
import { splitScopeId } from "../core/types";
import { getContext } from "../server/context";
import { CmlProvider } from "./cml";
import { DiscoveryProvider } from "./discovery";
import { loadAnsibleInventory } from "./ansible-inventory";
import { InventoryError, loadInventoryFile, type Inventory } from "./inventory-file";
import { NetboxProvider, loadNetboxConfig } from "./netbox";
import { StaticProvider } from "./static";

/**
 * The providers that are configured right now. CML needs the MCP connection; the file-based ones need
 * TS_INVENTORY_FILE; NetBox needs NETBOX_URL. Tests can replace the list.
 */
let override: InventoryProvider[] | null = null;
export function setProviders(p: InventoryProvider[] | null): void {
  override = p;
}

type FileProviders = { path: string; s: StaticProvider; d: DiscoveryProvider };
const g = globalThis as unknown as { __tsFiles?: FileProviders; __tsAnsible?: { path: string; p: StaticProvider }; __tsNetbox?: { key: string; p: NetboxProvider } };

export type ProviderProblem = { provider: string; message: string };
export const providerProblems: ProviderProblem[] = [];

/** One long-lived pair per inventory path, so transports (and their SSH sessions) are reused between requests. */
function fileProviders(): FileProviders | null {
  const path = process.env.TS_INVENTORY_FILE?.trim();
  if (!path) return null;
  if (g.__tsFiles?.path !== path) {
    const s = new StaticProvider(path);
    g.__tsFiles = { path, s, d: new DiscoveryProvider((): Inventory => s.inventory()) };
  }
  return g.__tsFiles;
}

/** An Ansible inventory, read through the same machinery as the inventory file. One long-lived provider per path. */
function ansibleProvider(): StaticProvider | null {
  const path = process.env.TS_ANSIBLE_INVENTORY?.trim();
  if (!path) return null;
  if (g.__tsAnsible?.path !== path) g.__tsAnsible = { path, p: new StaticProvider(path, "ansible", { kind: "ansible", label: "Ansible inventory", load: loadAnsibleInventory }) };
  return g.__tsAnsible.p;
}

export function getProviders(): InventoryProvider[] {
  if (override) return override;
  providerProblems.length = 0;
  const out: InventoryProvider[] = [];
  const ctx = getContext();
  if (ctx.mcp) out.push(new CmlProvider());
  try {
    const f = fileProviders();
    if (f) {
      const inv = f.s.inventory(); // validates the file now so a mistake is reported, not hidden
      out.push(f.s);
      if (inv.discovery.length) out.push(f.d);
    }
  } catch (e) {
    providerProblems.push({ provider: "Inventory file", message: e instanceof InventoryError ? e.message : `The inventory file could not be used: ${e instanceof Error ? e.message : "unknown error"}` });
  }
  try {
    const a = ansibleProvider();
    if (a) { a.inventory(); out.push(a); } // validates now so a mistake is reported, not hidden
  } catch (e) {
    providerProblems.push({ provider: "Ansible inventory", message: e instanceof InventoryError ? e.message : `The Ansible inventory could not be used: ${e instanceof Error ? e.message : "unknown error"}` });
  }
  try {
    const cfg = loadNetboxConfig();
    if (cfg) {
      const key = JSON.stringify([cfg.url, cfg.username, cfg.defaultEnvironment]);
      if (g.__tsNetbox?.key !== key) g.__tsNetbox = { key, p: new NetboxProvider(cfg) };
      out.push(g.__tsNetbox.p);
    }
  } catch (e) {
    providerProblems.push({ provider: "NetBox", message: e instanceof Error ? e.message : "NetBox is misconfigured." });
  }
  return out;
}

/** The provider that owns a scope id. A bare id belongs to CML. */
export function providerFor(scopeId: string): { provider: InventoryProvider | null; local: string } {
  const { providerId, local } = splitScopeId(scopeId);
  return { provider: getProviders().find((p) => p.id === providerId) ?? null, local };
}

export { loadInventoryFile };
