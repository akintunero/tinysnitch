import { connectMcp, describeEndpoint, getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Connection state only. Never includes keys, headers, env values or arguments. */
export const GET = route(async () => {
  await connectMcp(false, false); // never block a status read on a connection attempt
  const ctx = getContext();
  const health = ctx.mcp?.health() ?? null;
  return json({
    mcp: {
      configured: ctx.mcp !== null,
      configError: ctx.mcpConfigError,
      status: health?.status ?? "disconnected",
      transport: health?.transport ?? null,
      endpoint: describeEndpoint(ctx),
      server: health?.server ?? null,
      toolCount: health?.toolCount ?? 0,
      lastAttempt: health?.lastAttempt ?? null,
      lastError: health?.lastError ?? null,
    },
    claude: ctx.claude,
  });
});
