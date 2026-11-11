import type { NodeKind } from "../cml/node-types";

/** The read-only commands diagnostics runs. Every one passes the assistant's read-only policy before it is sent. */
export const CMD = {
  brief: "show ip interface brief",
  config: "show running-config",
  ospf: "show ip ospf neighbor",
  bgp: "show ip bgp summary",
  vlan: "show vlan brief",
  trunk: "show interfaces trunk",
  etherchannel: "show etherchannel summary",
} as const;

export type CommandKey = keyof typeof CMD;

const ROUTING: CommandKey[] = ["brief", "config", "ospf", "bgp"];
const SWITCHING: CommandKey[] = ["vlan", "trunk", "etherchannel"];

/** Device kinds Tiny Snitch knows how to interrogate over the IOS CLI, and what to ask each. */
export function commandsFor(kind: NodeKind): CommandKey[] | null {
  if (kind === "router") return ROUTING;
  if (kind === "l3switch") return [...ROUTING, ...SWITCHING];
  if (kind === "l2switch") return ["brief", "config", ...SWITCHING];
  return null;
}

export const COMMAND_TIMEOUT_NOTE = "Each command is one read-only call; failures are reported per command, never hidden.";
