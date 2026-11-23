/**
 * Phase 1 inspector: connect to the configured CML MCP server, list what it really exposes, and
 * optionally run one read-only tool.
 *
 *   npm run mcp:inspect                      list tools with their classification
 *   npm run mcp:inspect -- --probe           also run the first read tool that needs no arguments
 *   npm run mcp:inspect -- --call <tool> --args '{"title":"My Lab"}'    run one read-only tool
 *   npm run mcp:inspect -- --json            machine-readable output
 */
import { ConfigError, describeMcp, loadMcpConfig } from "../lib/config";
import { McpError, McpService, type ToolInfo } from "../lib/mcp/service";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const value = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

function required(t: ToolInfo): string[] {
  const r = (t.inputSchema as { required?: unknown }).required;
  return Array.isArray(r) ? r.map(String) : [];
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadMcpConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`CML MCP is not configured: ${e.message}`);
    console.error("Set the variables in .env.local (see .env.example):");
    console.error("  stdio: CML_MCP_TRANSPORT=stdio  CML_MCP_COMMAND=<command>  [CML_MCP_ARGS, CML_MCP_ENV]");
    console.error("  http : CML_MCP_TRANSPORT=http   CML_MCP_URL=<url>          [CML_MCP_HEADERS]");
    return 2;
  }

  console.log(`Connecting to ${describeMcp(config)}`);
  const svc = new McpService(config, { onLog: (l) => !flag("--json") && l.op !== "connect" && console.log(`  [mcp] ${l.op} ${l.tool ?? ""} ${l.ok ? "ok" : "FAILED"} ${l.ms ?? ""}${l.ms ? " ms" : ""}`) });
  try {
    await svc.connect();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  try {
    const tools = svc.tools();
    const health = svc.health();
    if (flag("--json")) {
      console.log(JSON.stringify({ health, tools }, null, 2));
    } else {
      console.log(`Connected to ${health.server?.name ?? "server"} ${health.server?.version ?? ""}. ${tools.length} tools:\n`);
      for (const t of tools) {
        const req = required(t);
        console.log(`  ${t.name}  [${t.classification.kind}]`);
        console.log(`    ${t.description.split("\n")[0].slice(0, 110)}`);
        console.log(`    args: ${Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).join(", ") || "none"}${req.length ? `  (required: ${req.join(", ")})` : ""}`);
        console.log(`    why ${t.classification.kind}: ${t.classification.reason}`);
      }
    }

    let target = value("--call");
    let args: unknown = {};
    if (value("--args")) {
      try {
        args = JSON.parse(value("--args")!);
      } catch {
        console.error("--args must be valid JSON.");
        return 2;
      }
    }
    if (flag("--probe") && !target) {
      const t = tools.find((x) => x.classification.kind === "read" && required(x).length === 0);
      if (!t) {
        console.log("\nNo read-only tool without required arguments to probe. Use --call with --args.");
        return 0;
      }
      target = t.name;
    }
    if (target) {
      const t = tools.find((x) => x.name === target);
      if (!t) {
        console.error(`\nNo tool named ${target}.`);
        return 2;
      }
      if (t.classification.kind !== "read") {
        console.error(`\nRefusing to run ${target}: classified ${t.classification.kind} (${t.classification.reason}). This inspector only runs read-only tools.`);
        return 2;
      }
      console.log(`\nCalling ${target} ...`);
      const r = await svc.callTool(target, args);
      console.log(`${r.ok ? "OK" : "TOOL REPORTED AN ERROR"} in ${r.durationMs} ms${r.truncated ? " (truncated)" : ""}:`);
      console.log(r.text.slice(0, 3000));
      return r.ok ? 0 : 1;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof McpError ? e.message : String(e));
    return 1;
  } finally {
    await svc.disconnect();
  }
}

process.exit(await main());
