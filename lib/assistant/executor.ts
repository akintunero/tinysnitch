import type { ExecuteResult, ToolExecutor } from "../anthropic/bridge";
import type { Db } from "../database/db";
import { addAudit } from "../database/repo";
import { McpError, type McpService } from "../mcp/service";
import { redactDeep, redactSecrets } from "../security/redact";
import { callsAuditedByCaller } from "../server/audit-scope";
import { checkCommandCall, type ToolSet } from "./policy";
import { PROPOSE_TOOL, runPropose } from "./propose";

/**
 * Runs Claude's tool requests, and only those in the allowed set. Device output is masked for secrets before
 * it reaches the model, the screen or the log, and every call is audited.
 */
export function createExecutor(opts: { db: Db; mcp: McpService; toolSet: ToolSet; scopeId?: string | null; onResult?: (r: ExecuteResult & { tool: string }) => void }): ToolExecutor {
  const { db, mcp, toolSet } = opts;
  return async (name, input) => {
    const started = Date.now();
    if (name === PROPOSE_TOOL.name) {
      const r = await runPropose(opts.scopeId ?? null, input);
      const out = { ...r, content: redactSecrets(r.content), durationMs: Date.now() - started };
      addAudit(db, { kind: "tool_call", actor: "claude", summary: `propose_change ${out.isError ? "refused" : "ok"}`, data: { tool: name, input: redactDeep(input), ms: out.durationMs } });
      opts.onResult?.({ ...out, tool: name });
      return out;
    }
    const finish = (r: ExecuteResult, audit: string): ExecuteResult => {
      const out = { ...r, content: redactSecrets(r.content), durationMs: Date.now() - started };
      addAudit(db, { kind: "tool_call", actor: "claude", summary: `${audit} ${out.isError ? "failed" : "ok"}`, data: { tool: name, input: redactDeep(input), ms: out.durationMs } });
      opts.onResult?.({ ...out, tool: name });
      return out;
    };

    const tool = toolSet.allowed.get(name);
    if (!tool) return finish({ content: `The tool "${name}" is not available to the assistant.`, isError: true }, name);

    let label = name;
    if (toolSet.command && name === toolSet.command.tool) {
      const check = checkCommandCall(toolSet.command, input);
      const args = (input ?? {}) as Record<string, unknown>;
      label = `${String(args[toolSet.command.commandsArg] ?? "").trim().slice(0, 80)}${typeof args.label === "string" ? ` on ${args.label}` : ""}`;
      if (!check.ok) return finish({ content: `Refused: ${check.reason}`, isError: true }, label);
    }

    try {
      const r = await callsAuditedByCaller.run(true, () => mcp.callTool(name, input)); // audited below, as claude
      return finish({ content: r.text, isError: !r.ok }, label);
    } catch (e) {
      const msg = e instanceof McpError ? e.message : e instanceof Error ? e.message : String(e);
      return finish({ content: msg, isError: true }, label);
    }
  };
}
