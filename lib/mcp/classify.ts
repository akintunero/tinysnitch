/**
 * Best-effort classification of discovered MCP tools. The server's own annotations win; names and
 * schemas are only a fallback, and anything unclear is treated as a write. This is a safety aid,
 * not a statement about what a tool really does.
 */

export type ToolKind = "read" | "write" | "destructive" | "mixed";
export type Classification = { kind: ToolKind; reason: string };

export type ClassifiableTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
};

const DESTRUCTIVE = /(delete|wipe|remove|erase|destroy|stop|clear|reset|reload|format)/i;
const READ = /^(get|list|read|show|check|describe|find|search|download|inspect|query|fetch)(_|-|$)/i;
// Tools that run caller-supplied commands can be read or write depending on the arguments.
const COMMAND_RUNNER = /(cli|command|exec|shell|run)/i;
const MODE_ARG = /(config|write|apply|commit|execute)/i;

function propertyNames(schema: unknown): string[] {
  if (schema && typeof schema === "object" && "properties" in schema) {
    const p = (schema as { properties?: unknown }).properties;
    if (p && typeof p === "object") return Object.keys(p);
  }
  return [];
}

export function classifyTool(t: ClassifiableTool): Classification {
  const a = t.annotations ?? {};
  const props = propertyNames(t.inputSchema);
  const runner = COMMAND_RUNNER.test(t.name) || props.some((p) => /^(commands?|cli)$/i.test(p));
  // Checked before annotations: a server may flag a command runner destructive because it *can*
  // change a device, yet the same tool is how read-only show commands are run.
  if (runner && props.some((p) => MODE_ARG.test(p))) {
    const hint = a.destructiveHint === true ? " (the server also marks it destructive)" : "";
    return { kind: "mixed", reason: `runs commands and has a mode argument; each call needs its own policy check${hint}` };
  }
  if (a.destructiveHint === true) return { kind: "destructive", reason: "server annotation: destructiveHint" };
  if (a.readOnlyHint === true) return { kind: "read", reason: "server annotation: readOnlyHint" };
  if (DESTRUCTIVE.test(t.name)) return { kind: "destructive", reason: "name suggests a destructive action" };
  if (READ.test(t.name)) return { kind: "read", reason: "name starts with a read verb (no server annotation)" };
  if (runner) return { kind: "mixed", reason: "runs commands; needs a per-call policy check" };
  return { kind: "write", reason: "not clearly read-only, so treated as a write" };
}
