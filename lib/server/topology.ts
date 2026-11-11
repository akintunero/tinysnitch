import { bindArgs, resolveCapabilities } from "../cml/capabilities";
import { CmlParseError } from "../cml/labs";
import { type Topology, buildTopology, parseInterfaces, parseLinks, parseNodes } from "../cml/topology";
import { McpError, type McpService } from "../mcp/service";
import { getContext } from "./context";
import { HttpError } from "./http";
import { fetchCmlLabs, requireMcp } from "./labs";

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: Topology }>();

export function clearTopologyCache(): void {
  cache.clear();
}

async function readTool(mcp: McpService, tool: string, args: Record<string, string>, what: string): Promise<string> {
  try {
    const r = await mcp.callTool(tool, args);
    if (!r.ok) throw new HttpError(502, `CML reported an error reading ${what}: ${r.text.slice(0, 200)}`);
    return r.text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof McpError) throw new HttpError(e.code === "timeout" ? 504 : 502, e.message);
    throw e;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * The lab's real nodes, links and interfaces, read through whatever tools the server exposes. Results are cached
 * for a few seconds so polling and page loads do not hammer CML; `refresh` bypasses the cache.
 */
export async function fetchTopology(scopeId: string, refresh = false): Promise<Topology> {
  const { getProviders, providerFor } = await import("../providers/registry");
  const { provider } = providerFor(scopeId);
  if (!provider) {
    if (getProviders().length === 0) throw new HttpError(503, getContext().mcpConfigError ?? "No inventory is configured: set up the CML MCP connection or an inventory file.", "mcp_unavailable");
    throw new HttpError(404, "That network is not provided by any configured inventory.");
  }
  return provider.getTopology(scopeId, refresh);
}

/** A CML lab's nodes, links and interfaces, read through the MCP server's tools. */
export async function fetchCmlTopology(labId: string, refresh = false): Promise<Topology> {
  const hit = cache.get(labId);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const { mcp } = await requireMcp();
  const caps = resolveCapabilities(mcp.tools());
  for (const [cap, label] of [["getLabNodes", "nodes"], ["getLabLinks", "links"], ["getNodeInterfaces", "interfaces"]] as const) {
    if (!caps[cap].tool) throw new HttpError(501, `${caps[cap].note} Tiny Snitch needs it to draw the topology (${label}).`, "capability_missing");
  }
  const tools = new Map(mcp.tools().map((t) => [t.name, t]));
  const nodesTool = tools.get(caps.getLabNodes.tool!)!;
  const linksTool = tools.get(caps.getLabLinks.tool!)!;
  const ifacesTool = tools.get(caps.getNodeInterfaces.tool!)!;

  const lab = (await fetchCmlLabs()).find((l) => l.id === labId);
  if (!lab) throw new HttpError(404, "CML has no lab with that id.");

  try {
    const warnings: string[] = [];
    const nodes = parseNodes(await readTool(mcp, nodesTool.name, bindArgs(nodesTool, { lab: labId }), "the lab's nodes"));
    const links = parseLinks(await readTool(mcp, linksTool.name, bindArgs(linksTool, { lab: labId }), "the lab's links"));
    const interfaces = new Map<string, ReturnType<typeof parseInterfaces>>();
    await mapLimit(nodes, 4, async (n) => {
      try {
        interfaces.set(n.id, parseInterfaces(await readTool(mcp, ifacesTool.name, bindArgs(ifacesTool, { lab: labId, node: n.id }), `${n.label}'s interfaces`)));
      } catch (e) {
        warnings.push(`Could not read the interfaces of ${n.label}: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    });
    const value = buildTopology({ id: lab.id, title: lab.title, state: lab.state, environment: "lab", providerId: "cml" }, nodes, links, interfaces, warnings);
    cache.set(labId, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (e instanceof CmlParseError) throw new HttpError(502, e.message);
    if (e instanceof Error && !(e instanceof HttpError)) throw new HttpError(502, e.message);
    throw e;
  }
}
