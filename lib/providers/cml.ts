import { type TopoNode, type Topology } from "../cml/topology";
import { buildToolSet, checkReadOnlyCommand } from "../assistant/policy";
import type { CommandOutcome, DeviceRef, DeviceTransport, Inspectable, InventoryProvider, PushOutcome, Scope } from "../core/types";
import { DEVICE_ERROR, blockedLines } from "../core/safety";
import { McpError, type McpService } from "../mcp/service";
import { redactSecrets } from "../security/redact";
import { callsAuditedByCaller } from "../server/audit-scope";
import { getContext } from "../server/context";
import { fetchCmlLabs } from "../server/labs";
import { fetchCmlTopology } from "../server/topology";

type Runner = { tool: string; labArg: string; labelArg: string; commandsArg: string; modeArg: string | null };

function findRunner(mcp: McpService): Runner | null {
  const policy = buildToolSet(mcp.tools()).command;
  const tool = policy ? mcp.tools().find((t) => t.name === policy.tool) : undefined;
  const props = Object.keys((tool?.inputSchema as { properties?: object } | undefined)?.properties ?? {});
  const labArg = props.find((p) => /^(lid|lab_id|labid|lab)$/i.test(p));
  const labelArg = props.find((p) => /^(label|node_label|nodelabel)$/i.test(p));
  return policy && labArg && labelArg ? { tool: policy.tool, labArg, labelArg, commandsArg: policy.commandsArg, modeArg: policy.modeArg } : null;
}

/** Whether the connected MCP server has a command tool Tiny Snitch can police. */
export function hasCliRunner(mcp: McpService): boolean {
  return findRunner(mcp) !== null;
}

const NO_RUNNER ="The CML MCP server has no tool Tiny Snitch can use to run CLI commands on nodes.";

/** Reaches a CML node's console through the MCP server's command tool. */
export class CmlTransport implements DeviceTransport {
  readonly kind = "cml-mcp" as const;
  constructor(private labId: string, private mcpOf: () => McpService | null = () => getContext().mcp) {}

  private async call(device: DeviceRef, commands: string, config: boolean): Promise<CommandOutcome> {
    const mcp = this.mcpOf();
    if (!mcp) return { ok: false, text: "The CML MCP connection is not configured." };
    const r = findRunner(mcp);
    if (!r) return { ok: false, text: NO_RUNNER };
    const args: Record<string, unknown> = { [r.labArg]: this.labId, [r.labelArg]: device.label, [r.commandsArg]: commands };
    if (r.modeArg) args[r.modeArg] = config;
    try {
      const res = await callsAuditedByCaller.run(true, () => mcp.callTool(r.tool, args));
      return { ok: res.ok, text: redactSecrets(res.text) };
    } catch (e) {
      return { ok: false, text: e instanceof McpError || e instanceof Error ? e.message : String(e) };
    }
  }

  async run(device: DeviceRef, command: string): Promise<CommandOutcome> {
    const check = checkReadOnlyCommand(command);
    if (!check.ok) return { ok: false, text: check.reason };
    return this.call(device, command.trim(), false);
  }

  async push(device: DeviceRef, commands: string[]): Promise<PushOutcome> {
    const bad = blockedLines(commands, device.platform);
    if (bad.length) return { ok: false, text: `Refused before sending anything: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}.`, applied: [], failedAt: bad[0].line };
    // CML takes the lines newline-separated and supplies "configure terminal" and "end" itself.
    const r = await this.call(device, commands.join("\n"), true);
    if (!r.ok) return { ok: false, text: r.text, applied: [], failedAt: null };
    const failedAt = DEVICE_ERROR.test(r.text) ? failingLine(r.text, commands) : null;
    if (!DEVICE_ERROR.test(r.text)) return { ok: true, text: r.text, applied: commands, failedAt: null };
    // Which lines took effect before the error is not reliably recoverable from one combined reply; rollback therefore
    // works from a fresh read of the device, never from this list.
    const at = failedAt ? commands.indexOf(failedAt) : -1;
    return { ok: false, text: r.text, applied: at > 0 ? commands.slice(0, at) : [], failedAt };
  }

  async save(device: DeviceRef): Promise<CommandOutcome> {
    const r = await this.call(device, "write memory", false);
    return { ok: r.ok && !DEVICE_ERROR.test(r.text), text: r.text };
  }
}

/** The configured line the device echoed just before it printed an error, if that can be told. */
export function failingLine(output: string, commands: string[]): string | null {
  const lines = output.split(/\r?\n/);
  const errAt = lines.findIndex((l) => DEVICE_ERROR.test(l));
  for (let i = errAt - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || /^\^$/.test(l)) continue;
    const hit = commands.find((c) => l.endsWith(c.trim()));
    if (hit) return hit;
  }
  return null;
}

export class CmlProvider implements InventoryProvider {
  readonly id = "cml";
  readonly kind = "cml" as const;
  readonly label = "Cisco Modeling Labs";

  async listScopes(): Promise<Scope[]> {
    return (await fetchCmlLabs()).map((l) => ({
      id: l.id, providerId: "cml", providerKind: "cml" as const, title: l.title, state: l.state, environment: "lab" as const,
      nodeCount: l.nodeCount, linkCount: l.linkCount, description: l.description, owner: l.owner,
    }));
  }

  getTopology(scopeId: string, refresh = false): Promise<Topology> {
    return fetchCmlTopology(scopeId, refresh);
  }

  transport(scopeId: string): DeviceTransport {
    return new CmlTransport(scopeId);
  }

  inspectable(n: TopoNode): Inspectable {
    return n.state === "BOOTED" ? { ok: true } : { ok: false, reason: `Not running (state ${n.state.toLowerCase().replace(/_/g, " ")}).` };
  }
}
