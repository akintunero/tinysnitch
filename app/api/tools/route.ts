import { resolveCapabilities } from "@/lib/cml/capabilities";
import { json, route } from "@/lib/server/http";
import { requireMcp } from "@/lib/server/labs";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const { mcp } = await requireMcp();
  const tools = mcp.tools();
  return json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      kind: t.classification.kind,
      reason: t.classification.reason,
      args: Object.keys((t.inputSchema as { properties?: object }).properties ?? {}),
      required: ((t.inputSchema as { required?: string[] }).required ?? []),
    })),
    capabilities: resolveCapabilities(tools),
  });
});
