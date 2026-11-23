import type { NodeKind } from "../cml/node-types";
import type { Platform } from "../core/types";
import { CMD, type CommandKey } from "./commands";
import {
  type BgpPeer, type DeviceCfg, type EtherChannel, type IfBriefRow, type OspfNeighbor, type TrunkPort,
  parseBgpSummary, parseEtherchannel, parseIpIntBrief, parseOspfNeighbors, parsePing, parseRunningConfig, parseTrunk, parseVlanBrief,
} from "./parsers";
import { parseEosBgpSummary, parseEosConfig, parseEosIpIntBrief, parseEosOspfNeighbors, parseEosPing } from "./parsers-eos";
import { parseJunosBgpSummary, parseJunosConfig, parseJunosInterfacesTerse, parseJunosOspfNeighbors } from "./parsers-junos";
import { parseNxosConfig, parseNxosIpIntBrief, parseNxosOspfNeighbors } from "./parsers-nxos";

/**
 * Everything dialect-specific that diagnostics needs. A platform with a driver can be inspected; any other is
 * reported as not inspected, never half-read. Results are normalised, so the checks do not know which dialect ran.
 */
export type Driver = {
  id: Platform;
  /** The dialect's real command for each logical key. A key missing here is not collected on this platform. */
  commands: Partial<Record<CommandKey, string>>;
  ping(ip: string): string;
  parse: {
    brief(t: string): IfBriefRow[];
    config(t: string): DeviceCfg;
    ospf(t: string): OspfNeighbor[];
    bgp(t: string): BgpPeer[];
    vlan?(t: string): Map<string, string>;
    trunk?(t: string): TrunkPort[];
    etherchannel?(t: string): EtherChannel[];
    ping(t: string): { successRate: number; received: number; sent: number } | null;
  };
  /** Said in every run so a missing check is never read as a clean result. */
  limits: string[];
};

const IOS: Driver = {
  id: "ios",
  commands: CMD,
  ping: (ip) => `ping ${ip} repeat 2 timeout 1`,
  parse: {
    brief: parseIpIntBrief, config: parseRunningConfig, ospf: parseOspfNeighbors, bgp: parseBgpSummary,
    vlan: parseVlanBrief, trunk: parseTrunk, etherchannel: parseEtherchannel, ping: parsePing,
  },
  limits: [],
};

const EOS: Driver = {
  id: "eos",
  commands: { brief: "show ip interface brief", config: "show running-config", ospf: "show ip ospf neighbor", bgp: "show ip bgp summary" },
  ping: (ip) => `ping ${ip} repeat 2`,
  parse: { brief: parseEosIpIntBrief, config: parseEosConfig, ospf: parseEosOspfNeighbors, bgp: parseEosBgpSummary, ping: parseEosPing },
  limits: ["Arista EOS: VLAN, trunk and port-channel state are not collected, and the EOS parsers have only been tested on documented sample output, not a real device"],
};

const NXOS: Driver = {
  id: "nxos",
  commands: { brief: "show ip interface brief", config: "show running-config", ospf: "show ip ospf neighbors", bgp: "show ip bgp summary", vlan: "show vlan brief" },
  ping: (ip) => `ping ${ip} count 2`,
  parse: { brief: parseNxosIpIntBrief, config: parseNxosConfig, ospf: parseNxosOspfNeighbors, bgp: parseBgpSummary, vlan: parseVlanBrief, ping: parseEosPing },
  limits: ["Cisco NX-OS: trunk and port-channel state are not collected, and the NX-OS parsers have only been tested on documented sample output, not a real device"],
};

const JUNOS: Driver = {
  id: "junos",
  commands: { brief: "show interfaces terse", config: "show configuration | display set", ospf: "show ospf neighbor", bgp: "show bgp summary" },
  ping: (ip) => `ping ${ip} count 2 rapid`,
  parse: { brief: parseJunosInterfacesTerse, config: parseJunosConfig, ospf: parseJunosOspfNeighbors, bgp: parseJunosBgpSummary, ping: parseEosPing },
  limits: ["Juniper Junos: VLAN, trunk and aggregated-ethernet state are not collected, and the Junos parsers have only been tested on documented sample output, not a real device"],
};

const DRIVERS: Partial<Record<Platform, Driver>> = { ios: IOS, eos: EOS, nxos: NXOS, junos: JUNOS };

export function driverFor(platform: Platform | undefined): Driver | null {
  return DRIVERS[platform ?? "ios"] ?? null;
}

export const supportedPlatforms = (): Platform[] => Object.keys(DRIVERS) as Platform[];

const ROUTING: CommandKey[] = ["brief", "config", "ospf", "bgp"];
const SWITCHING: CommandKey[] = ["vlan", "trunk", "etherchannel"];

/** The logical keys to collect for a device kind, narrowed to what the platform's driver can do. */
export function keysFor(kind: NodeKind, driver: Driver): CommandKey[] | null {
  const want = kind === "router" ? ROUTING : kind === "l3switch" ? [...ROUTING, ...SWITCHING] : kind === "l2switch" ? (["brief", "config", ...SWITCHING] as CommandKey[]) : null;
  return want ? want.filter((k) => driver.commands[k]) : null;
}
