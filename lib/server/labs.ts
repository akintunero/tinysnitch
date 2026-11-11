import { type LabSummary, CmlParseError, parseLabs } from "../cml/labs";
import { resolveCapabilities } from "../cml/capabilities";
import { McpError } from "../mcp/service";
import { getProviders, providerProblems } from "../providers/registry";
import { type Ctx, connectMcp, getContext } from "./context";
import { HttpError } from "./http";

/** Connected MCP service, or an honest 503 saying what is wrong with the connection. */
export async function requireMcp(): Promise<{ ctx: Ctx; mcp: NonNullable<Ctx["mcp"]> }> {
  const ctx = getContext();
  if (!ctx.mcp) throw new HttpError(503, ctx.mcpConfigError ?? "The CML MCP connection is not configured.", "mcp_unavailable");
  await connectMcp();
  const h = ctx.mcp.health();
  if (h.status !== "connected") {
    throw new HttpError(503, `The CML MCP server is not connected${h.lastError ? `: ${h.lastError}` : "."}`, "mcp_unavailable");
  }
  return { ctx, mcp: ctx.mcp };
}

/** The CML server's own lab list. */
export async function fetchCmlLabs(): Promise<LabSummary[]> {
  const { mcp } = await requireMcp();
  const cap = resolveCapabilities(mcp.tools()).listLabs;
  if (!cap.tool) throw new HttpError(501, cap.note, "capability_missing");
  try {
    const r = await mcp.callTool(cap.tool, {});
    if (!r.ok) throw new HttpError(502, `CML reported an error listing labs: ${r.text.slice(0, 200)}`);
    return parseLabs(r.text).map((l) => ({ ...l, providerId: "cml", providerKind: "cml" as const, environment: "lab" as const }));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof McpError) throw new HttpError(e.code === "timeout" ? 504 : 502, e.message);
    if (e instanceof CmlParseError) throw new HttpError(502, e.message);
    throw e;
  }
}

export type ScopeList = { labs: LabSummary[]; warnings: string[] };

/**
 * Every selectable network from every configured provider. One provider being down does not hide the others; its
 * problem is returned as a warning. If every provider fails, the first failure is raised.
 */
export async function fetchScopes(): Promise<ScopeList> {
  const providers = getProviders();
  if (providers.length === 0) {
    const why = [getContext().mcpConfigError, ...providerProblems.map((p) => `${p.provider}: ${p.message}`)].filter(Boolean).join(" ");
    throw new HttpError(503, why || "No inventory is configured: set up the CML MCP connection or an inventory file.", "mcp_unavailable");
  }
  const labs: LabSummary[] = [];
  const warnings: string[] = [];
  let first: unknown = null;
  let ok = 0;
  for (const p of providers) {
    try {
      const scopes = await p.listScopes();
      ok++;
      for (const s of scopes) {
        labs.push({ id: s.id, title: s.title, state: s.state, nodeCount: s.nodeCount, linkCount: s.linkCount, owner: s.owner, description: s.description, providerId: s.providerId, providerKind: s.providerKind, environment: s.environment });
      }
    } catch (e) {
      first ??= e;
      warnings.push(`${p.label}: ${e instanceof Error ? e.message : "could not be read"}`);
    }
  }
  if (!ok) throw first;
  for (const p of providerProblems) warnings.push(`${p.provider}: ${p.message}`);
  return { labs, warnings };
}

/** Kept for callers that only want the list. */
export async function fetchLabs(): Promise<LabSummary[]> {
  return (await fetchScopes()).labs;
}
