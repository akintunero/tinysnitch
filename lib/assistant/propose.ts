import { z } from "zod";
import type { BridgeTool, ExecuteResult } from "../anthropic/bridge";
import { ChangeError, proposeAndMaybeApply } from "../changes/engine";

/**
 * The only way the assistant can alter a network, and it does not alter one itself: it files a proposal. Whether the
 * proposal is applied is decided by the execution mode and, in Approve mode, by a person.
 */
export const PROPOSE_TOOL: BridgeTool = {
  name: "propose_change",
  description:
    "File a configuration change for review. This does NOT change anything by itself: a person approves it in Tiny Snitch (or, in Autopilot, only a small low-risk change in a lab is applied automatically). " +
    "Give the exact configuration lines per device, without 'configure terminal' or 'end'. The result states what happened; report exactly that and never claim it was applied unless the result says so.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short title for the change." },
      intent: { type: "string", description: "What the change is meant to achieve, in one or two sentences." },
      devices: {
        type: "array",
        items: { type: "object", properties: { device: { type: "string", description: "Device name exactly as in the topology." }, commands: { type: "array", items: { type: "string" } } }, required: ["device", "commands"], additionalProperties: false },
      },
    },
    required: ["title", "intent", "devices"],
    additionalProperties: false,
  },
};

const input = z.object({ title: z.string().min(1).max(200), intent: z.string().max(2000).default(""), devices: z.array(z.object({ device: z.string().min(1), commands: z.array(z.string().max(400)).min(1).max(300) })).min(1).max(20) });

export async function runPropose(scopeId: string | null, raw: unknown): Promise<ExecuteResult> {
  if (!scopeId) return { content: "No network is selected. Ask the engineer to choose one first.", isError: true };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { content: `The proposal was not valid: ${parsed.error.issues[0]?.path.join(".") || "input"} ${parsed.error.issues[0]?.message ?? ""}`, isError: true };
  try {
    const r = await proposeAndMaybeApply({ scopeId, source: "assistant", ...parsed.data });
    const lines = r.change.plan.devices.map((d) => `${d.label}: ${d.commands.length} line(s)`).join("; ");
    return {
      content: [
        `Change "${r.change.title}" (id ${r.change.id}) is ${r.change.status}.`,
        `Environment: ${r.change.environment}. Devices: ${lines}.`,
        r.change.plan.warnings.length ? `Notes: ${r.change.plan.warnings.join(" ")}` : "",
        r.note,
        r.change.result?.summary ? `Result: ${r.change.result.summary}` : "",
        r.applied ? "" : "It has NOT been applied to any device.",
      ].filter(Boolean).join("\n"),
      isError: false,
    };
  } catch (e) {
    if (e instanceof ChangeError) return { content: `Not filed: ${e.message}`, isError: true };
    return { content: `Not filed: ${e instanceof Error ? e.message : "unexpected error"}`, isError: true };
  }
}
