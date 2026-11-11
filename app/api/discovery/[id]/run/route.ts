import { addAudit } from "@/lib/database/repo";
import { DiscoveryProvider } from "@/lib/providers/discovery";
import { getProviders } from "@/lib/providers/registry";
import { clearTopologyCache } from "@/lib/server/topology";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const running = new Set<string>();

/** Crawls CDP/LLDP neighbour tables from the configured seeds. Read-only; bounded by the definition's caps. */
export const POST = route(async (_req, params) => {
  const id = params.id;
  const provider = getProviders().find((p): p is DiscoveryProvider => p instanceof DiscoveryProvider);
  if (!provider) throw new HttpError(404, "No discovery is defined. Add a `discovery:` entry to the inventory file.");
  const scopeId = `discovery:${id}`;
  if (running.has(scopeId)) throw new HttpError(409, "Discovery is already running.");
  running.add(scopeId);
  try {
    const result = await provider.run(scopeId).catch((e: unknown) => {
      throw new HttpError(404, e instanceof Error ? e.message : "Discovery failed.");
    });
    clearTopologyCache();
    addAudit(getContext().db, { kind: "lab", actor: "user", summary: `Discovery ${id}: ${result.devices.length} devices, ${result.links.length} links`, data: { scopeId, warnings: result.warnings } });
    return json({ devices: result.devices.length, links: result.links.length, warnings: result.warnings, at: result.at });
  } finally {
    running.delete(scopeId);
  }
}, { write: true });
