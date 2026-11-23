import type { BridgeTool, ExecuteResult, ToolExecutor } from "../anthropic/bridge";
import { type InventoryProvider, nodeRef } from "../core/types";
import type { Db } from "../database/db";
import { addAudit } from "../database/repo";
import { redactDeep, redactSecrets } from "../security/redact";
import { PROPOSE_TOOL, runPropose } from "./propose";

/**
 * The assistant's tools for networks that do not come from CML: read the topology, and run one read-only command on
 * a device. They work the same for an inventory file, NetBox or a discovery crawl, because they go through the
 * provider and its transport, which enforce the read-only allowlist themselves.
 */
export const NEUTRAL_TOOLS: BridgeTool[] = [
  {
    name: "get_topology",
    description: "List the devices (name, role, platform, management address) and the links between them (device and interface at each end) in the selected network. Links are as recorded or discovered, not proof that traffic passes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_command",
    description: "Run one read-only command (show, ping or traceroute) on a device in the selected network and return its output. One command per call. Configuration commands are refused.",
    inputSchema: { type: "object", properties: { device: { type: "string", description: "Device name exactly as returned by get_topology." }, command: { type: "string" } }, required: ["device", "command"], additionalProperties: false },
  },
  PROPOSE_TOOL,
];

export function createNeutralExecutor(opts: { db: Db; provider: InventoryProvider; scopeId: string; onResult?: (r: ExecuteResult & { tool: string }) => void }): ToolExecutor {
  const { db, provider, scopeId } = opts;
  return async (name, input) => {
    const started = Date.now();
    const finish = (r: ExecuteResult, audit: string): ExecuteResult => {
      const out = { ...r, content: redactSecrets(r.content), durationMs: Date.now() - started };
      addAudit(db, { kind: "tool_call", actor: "claude", summary: `${audit} ${out.isError ? "failed" : "ok"}`, data: { tool: name, scopeId, input: redactDeep(input), ms: out.durationMs } });
      opts.onResult?.({ ...out, tool: name });
      return out;
    };
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    if (name === PROPOSE_TOOL.name) return finish(await runPropose(scopeId, input), "propose_change");
    try {
      if (name === "get_topology") {
        const t = await provider.getTopology(scopeId);
        const names = new Map(t.nodes.map((n) => [n.id, n.label]));
        return finish({
          content: JSON.stringify(redactDeep({
            network: t.lab.title, environment: t.lab.environment ?? null, warnings: t.warnings,
            devices: t.nodes.map((n) => ({ name: n.label, role: n.kind, platform: n.platform ?? "ios", address: n.address ?? null, readable: provider.inspectable(n).ok })),
            links: t.links.map((l) => ({ a: `${names.get(l.source)} ${l.sourceInterface}`, b: `${names.get(l.target)} ${l.targetInterface}`, source: l.statusText })),
          }), null, 1),
          isError: false,
        }, "get_topology");
      }
      if (name === "run_command") {
        const device = typeof args.device === "string" ? args.device : "";
        const command = typeof args.command === "string" ? args.command : "";
        const label = `${command.trim().slice(0, 80)} on ${device}`;
        const t = await provider.getTopology(scopeId);
        const node = t.nodes.find((n) => n.label === device);
        if (!node) return finish({ content: `There is no device named "${device}" in this network. Use get_topology for the names.`, isError: true }, label);
        const can = provider.inspectable(node);
        if (!can.ok) return finish({ content: `Cannot read ${device}: ${can.reason}`, isError: true }, label);
        const r = await provider.transport(scopeId).run(nodeRef(node), command);
        return finish({ content: r.text, isError: !r.ok }, label);
      }
      return finish({ content: `The tool "${name}" is not available to the assistant.`, isError: true }, name);
    } catch (e) {
      return finish({ content: e instanceof Error ? e.message : String(e), isError: true }, name);
    }
  };
}
