/**
 * What Claude may do in the assistant. Today that is reading only: tools the server marks read-only, plus the
 * command-running tool limited to show, ping and traceroute. Everything that changes a lab or a device is
 * withheld; changes go through the approval workflow built in Phase 6.
 */
import { resolveCapabilities } from "../cml/capabilities";
import type { BridgeTool } from "../anthropic/bridge";
import type { ToolInfo } from "../mcp/service";

export type CommandPolicy = { tool: string; commandsArg: string; modeArg: string | null };
export type ToolSet = {
  tools: BridgeTool[];
  /** Tool name -> how to execute it. Anything not here is refused, whatever Claude asks for. */
  allowed: Map<string, ToolInfo>;
  command: CommandPolicy | null;
};

// Large binary payloads are useless to a language model and would only burn tokens.
const EXCLUDED = /(packet_capture_data)/i;

const READ_COMMAND = /^(show|ping|traceroute)(\s|$)/i;
const WRITES_OUTPUT = /(\|\s*(redirect|tee|append)\b|>)/i;

export type CommandCheck = { ok: true } | { ok: false; reason: string };

/** One read-only command per call. Anything else is refused with a reason Claude can act on. */
export function checkReadOnlyCommand(raw: unknown): CommandCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "No command was given." };
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return { ok: false, reason: "Send exactly one command per call." };
  const cmd = lines[0];
  if (cmd.includes(";")) return { ok: false, reason: "Command chaining with ';' is not allowed." };
  if (!READ_COMMAND.test(cmd)) return { ok: false, reason: `"${cmd.slice(0, 60)}" is not allowed. Only show, ping and traceroute commands can be run; configuration changes are not available yet.` };
  if (WRITES_OUTPUT.test(cmd)) return { ok: false, reason: "Redirecting command output is not allowed." };
  return { ok: true };
}

export function buildToolSet(all: ToolInfo[]): ToolSet {
  const allowed = new Map<string, ToolInfo>();
  const tools: BridgeTool[] = [];
  const runner = resolveCapabilities(all).runCommand.tool;
  let command: CommandPolicy | null = null;

  for (const t of all) {
    if (EXCLUDED.test(t.name)) continue;
    if (t.classification.kind === "read") {
      allowed.set(t.name, t);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    } else if (t.name === runner) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      const commandsArg = props.find((p) => /^(commands?|cli)$/i.test(p));
      if (!commandsArg) continue; // can't police a tool whose command argument we can't identify
      command = { tool: t.name, commandsArg, modeArg: props.find((p) => /config/i.test(p)) ?? null };
      allowed.set(t.name, t);
      tools.push({
        name: t.name,
        description: `${t.description}\n\nTiny Snitch limit: only read-only show, ping and traceroute commands are allowed, one command per call, never in configuration mode.`,
        inputSchema: t.inputSchema,
      });
    }
  }
  return { tools, allowed, command };
}

/** Refuses a call to the command runner that could change a device. */
export function checkCommandCall(policy: CommandPolicy, input: unknown): CommandCheck {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (policy.modeArg && args[policy.modeArg] !== undefined && args[policy.modeArg] !== false) {
    return { ok: false, reason: "Configuration mode is not available. Only read-only commands can be run." };
  }
  return checkReadOnlyCommand(args[policy.commandsArg]);
}
