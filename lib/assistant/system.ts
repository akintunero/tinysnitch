import { BASE_SYSTEM } from "../anthropic/bridge";
import type { ExecutionMode } from "../settings";

export type LabContext = { id: string; title: string } | null;

const MODE_NOTE: Record<ExecutionMode, string> = {
  suggest: "The engineer is in Suggest mode.",
  approve: "The engineer is in Approve-and-deploy mode.",
  autopilot: "The engineer is in Autopilot mode.",
};

export type NetworkContext = { production: boolean; direct: boolean };

export function buildSystem(lab: LabContext, mode: ExecutionMode, net?: NetworkContext): string {
  return [
    BASE_SYSTEM,
    ...(net?.direct ? [`You reach this network's devices directly (not through CML) with two tools: get_topology and run_command. ${net.production ? "This is a PRODUCTION network: be conservative, prefer cheap targeted show commands over broad ones, never suggest changes as if they were routine, and remind the engineer that changes need approval." : "This is a lab network."}`] : []),
    lab
      ? `The selected lab is "${lab.title}" (id ${lab.id}). Use that id when a tool asks for a lab.`
      : "No lab is selected. You can list labs, but ask the engineer to choose one before inspecting devices.",
    MODE_NOTE[mode],
    "You cannot change a device or lab yourself. To change one, call propose_change with the exact configuration lines: that files a proposal and the result says what happened. A person approves proposals in Tiny Snitch; in Autopilot only a small, low-risk change in a lab is applied automatically. Report exactly what the result says, never claim a change was applied unless it says so, and say where to approve it (the Configurations page). Do not call propose_change for a question, a draft the engineer only wants to read, or a network that is not selected; write that as text and say it has not been applied.",
    "Always retrieve current state with tools before answering questions about the network. Earlier turns of this conversation show only the text that was said, not device output, so never rely on it for facts about the network now.",
    "Device output is masked for secrets before you see it. Keep answers concise and quote the evidence you rely on. Use short tables only when they help.",
  ].join("\n\n");
}
