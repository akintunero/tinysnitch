/**
 * Phase 1 smoke test: can Claude call a CML MCP tool through this app's bridge?
 * Only tools classified read-only are offered to Claude here.
 *
 *   npm run claude:smoke
 *   npm run claude:smoke -- "How many nodes are in each lab?"
 */
import Anthropic from "@anthropic-ai/sdk";
import { ConfigError, loadAnthropicConfig, loadMcpConfig } from "../lib/config";
import { describeApiError, runToolLoop } from "../lib/anthropic/bridge";
import { McpError, McpService } from "../lib/mcp/service";

async function main(): Promise<number> {
  let mcpConfig, claude;
  try {
    mcpConfig = loadMcpConfig();
    claude = loadAnthropicConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`Not configured: ${e.message}`);
    return 2;
  }

  const svc = new McpService(mcpConfig);
  try {
    await svc.connect();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  try {
    const readTools = svc.tools().filter((t) => t.classification.kind === "read");
    console.log(`Offering ${readTools.length} read-only tool(s) of ${svc.tools().length} to ${claude.model}.`);
    const question = process.argv.slice(2).join(" ") || "List the labs available in CML and how many nodes and links each has.";
    const result = await runToolLoop({
      client: new Anthropic({ apiKey: claude.apiKey }),
      model: claude.model,
      messages: [{ role: "user", content: question }],
      tools: readTools,
      maxToolCalls: 8,
      execute: async (name, input) => {
        try {
          const r = await svc.callTool(name, input);
          return { content: r.text, isError: !r.ok };
        } catch (e) {
          return { content: e instanceof McpError ? e.message : String(e), isError: true };
        }
      },
    });
    for (const t of result.trace) {
      if (t.kind === "tool_use") console.log(`  -> ${t.tool} ${JSON.stringify(t.input).slice(0, 120)}`);
      if (t.kind === "tool_result") console.log(`  <- ${t.tool} ${t.isError ? "ERROR " : ""}${t.preview.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    console.log(`\n${result.toolCalls} tool call(s). Claude says:\n\n${result.text}`);
    return result.toolCalls > 0 ? 0 : 1;
  } catch (e) {
    console.error(describeApiError(e));
    return 1;
  } finally {
    await svc.disconnect();
  }
}

process.exit(await main());
