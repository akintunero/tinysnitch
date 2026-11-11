import { addAudit } from "@/lib/database/repo";
import { connectMcp, getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const ctx = getContext();
  if (!ctx.mcp) return json({ error: ctx.mcpConfigError ?? "The CML MCP connection is not configured." }, 503);
  addAudit(ctx.db, { kind: "mcp", actor: "user", summary: "Reconnect requested" });
  await ctx.mcp.disconnect();
  await connectMcp(true);
  const h = ctx.mcp.health();
  return json({ status: h.status, toolCount: h.toolCount, lastError: h.lastError ?? null }, h.status === "connected" ? 200 : 502);
}, { write: true });
