import type { ToolInfo } from "../mcp/service";

/**
 * What Tiny Snitch needs from a CML MCP server, matched against the tools actually discovered. Matching
 * is by shape (kind, required arguments, name pattern), never by a fixed tool name, and a capability the
 * server lacks is reported as missing rather than faked.
 */
export type Capability = "listLabs" | "getLabNodes" | "getLabLinks" | "getNodeInterfaces" | "runCommand";

export type Resolved = { tool: string | null; note: string };

const required = (t: ToolInfo): string[] => {
  const r = (t.inputSchema as { required?: unknown }).required;
  return Array.isArray(r) ? r.map(String) : [];
};

const RULES: Record<Capability, { kinds: ToolInfo["classification"]["kind"][]; name: RegExp; args: (r: string[]) => boolean; need: string }> = {
  listLabs: { kinds: ["read"], name: /(get|list)_?.*labs$/i, args: (r) => r.length === 0, need: "a read-only tool that lists labs without required arguments" },
  getLabNodes: { kinds: ["read"], name: /nodes/i, args: (r) => r.length >= 1, need: "a read-only tool that returns a lab's nodes" },
  getLabLinks: { kinds: ["read"], name: /links/i, args: (r) => r.length >= 1, need: "a read-only tool that returns a lab's links" },
  getNodeInterfaces: { kinds: ["read"], name: /interfaces/i, args: (r) => r.length >= 2, need: "a read-only tool that returns a node's interfaces" },
  runCommand: { kinds: ["mixed"], name: /(cli|command)/i, args: (r) => r.length >= 2, need: "a tool that runs CLI commands on a node" },
};

const ARG_PATTERNS = { lab: /^(lid|lab_id|labid|lab)$/i, node: /^(nid|node_id|nodeid|node)$/i } as const;

/**
 * Builds a call's arguments from the tool's own schema, finding which property takes the lab id and which the
 * node id by name pattern. Throws if a required property can't be filled, instead of guessing.
 */
export function bindArgs(tool: ToolInfo, values: { lab?: string; node?: string }): Record<string, string> {
  const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
  const args: Record<string, string> = {};
  for (const [role, value] of Object.entries(values) as ["lab" | "node", string | undefined][]) {
    if (value === undefined) continue;
    const name = props.find((p) => ARG_PATTERNS[role].test(p));
    if (!name) throw new Error(`Tool ${tool.name} has no argument that takes a ${role} id.`);
    args[name] = value;
  }
  const missing = required(tool).filter((r) => !(r in args));
  if (missing.length) throw new Error(`Tool ${tool.name} needs ${missing.join(", ")}, which Tiny Snitch can't supply.`);
  return args;
}

export function resolveCapabilities(tools: ToolInfo[]): Record<Capability, Resolved> {
  const out = {} as Record<Capability, Resolved>;
  for (const [cap, rule] of Object.entries(RULES) as [Capability, (typeof RULES)[Capability]][]) {
    const hit = tools.find((t) => rule.kinds.includes(t.classification.kind) && rule.name.test(t.name) && rule.args(required(t)));
    out[cap] = hit ? { tool: hit.name, note: hit.classification.reason } : { tool: null, note: `The server exposes no ${rule.need}.` };
  }
  return out;
}
