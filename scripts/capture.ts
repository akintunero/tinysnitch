/**
 * Captures the raw output of the diagnostic commands from a running CML lab, read-only, into tests/fixtures/captured.
 * Real output is the only honest test input for the parsers. Secrets are redacted before anything is written.
 *
 *   npm run capture -- <labId> [label ...]      all running nodes when no label is given
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildToolSet, checkReadOnlyCommand } from "../lib/assistant/policy";
import { loadMcpConfig } from "../lib/config";
import { CMD } from "../lib/diagnostics/commands";
import { McpService } from "../lib/mcp/service";
import { redactSecrets } from "../lib/security/redact";

const [labId, ...labels] = process.argv.slice(2);
if (!labId) { console.error("usage: npm run capture -- <labId> [label ...]"); process.exit(2); }

const svc = new McpService(loadMcpConfig(), {});
await svc.connect();
try {
  const policy = buildToolSet(svc.tools()).command;
  if (!policy) throw new Error("No read-only CLI tool on the MCP server.");
  const props = Object.keys((svc.tools().find((t) => t.name === policy.tool)?.inputSchema as { properties?: object }).properties ?? {});
  const labProp = props.find((p) => /^(lid|lab_id|labid|lab)$/i.test(p))!;
  const labelProp = props.find((p) => /^(label|node_label|nodelabel)$/i.test(p))!;
  const dir = join("tests", "fixtures", "captured");
  mkdirSync(dir, { recursive: true });
  const extra = ["show version", "show ip protocols", "show cdp neighbors detail", "show lldp neighbors detail", "show ip route", "show spanning-tree"];
  for (const label of labels) {
    for (const command of [...Object.values(CMD), ...extra]) {
      if (!checkReadOnlyCommand(command).ok) continue;
      const args: Record<string, unknown> = { [labProp]: labId, [labelProp]: label, [policy.commandsArg]: command };
      if (policy.modeArg) args[policy.modeArg] = false;
      try {
        const r = await svc.callTool(policy.tool, args);
        writeFileSync(join(dir, `${label}__${command.replace(/\W+/g, "_")}.txt`), redactSecrets(r.text));
        console.log(`${label}: ${command} (${r.ok ? "ok" : "error"})`);
      } catch (e) { console.log(`${label}: ${command} FAILED ${(e as Error).message.slice(0, 80)}`); }
    }
  }
} finally { await svc.disconnect(); }
process.exit(0);
