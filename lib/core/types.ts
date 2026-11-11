/**
 * The seam between Tiny Snitch and whatever holds the network: an inventory provider says what exists (CML, a file,
 * NetBox, a discovery crawl), a transport talks to the devices (CML's MCP server, SSH). Diagnostics, the assistant
 * and the configuration engine are written against these two interfaces only.
 */
import type { NodeKind } from "../cml/node-types";
import type { TopoNode, Topology } from "../cml/topology";

/** `lab` environments may allow automatic changes; `production` never does. */
export type Environment = "lab" | "production";

export type Platform = "ios" | "nxos" | "eos" | "junos" | "unknown";
export const PLATFORMS: Platform[] = ["ios", "nxos", "eos", "junos", "unknown"];

/** A selectable network: a CML lab, a site in an inventory file or NetBox, or one discovery crawl. */
export type Scope = {
  /** CML lab ids are bare; every other provider's scopes are `provider:local-id`. */
  id: string;
  providerId: string;
  providerKind: ProviderKind;
  title: string;
  state: string;
  environment: Environment;
  nodeCount: number | null;
  linkCount: number | null;
  description: string;
  owner: string | null;
};

export type ProviderKind = "cml" | "static" | "netbox" | "discovery";

export type DeviceRef = { id: string; label: string; kind: NodeKind; platform: Platform };

export type CommandOutcome = { ok: boolean; text: string };
/** `final` asks for a permanent change at once; the default on platforms with provisional commits is provisional. */
export type PushOptions = { final?: boolean };

export type PushOutcome = {
  ok: boolean;
  /** Everything the device printed while the commands went in. */
  text: string;
  /** The lines the device accepted, in order. On failure this stops before the line it rejected. */
  applied: string[];
  /** The line the device rejected, if any. */
  failedAt: string | null;
};

/** How to reach devices. `run` is read-only by construction; `push` only ever runs after an approval. */
export interface DeviceTransport {
  readonly kind: "cml-mcp" | "ssh" | "netconf" | "eapi" | "nxapi" | "mixed";
  /** One show, ping or traceroute command. Anything else is refused here, whatever the caller asks. */
  run(device: DeviceRef, command: string): Promise<CommandOutcome>;
  /** Configuration lines applied in configuration mode. Refuses commands that are never allowed. */
  push(device: DeviceRef, commands: string[], opts?: PushOptions): Promise<PushOutcome>;
  /** Whether this device can be configured through this transport, with the reason when it cannot. */
  pushSupport?(device: DeviceRef): { ok: true } | { ok: false; reason: string };
  /**
   * For platforms with provisional commits (Junos "commit confirmed"): make the last push permanent. A push that is
   * never confirmed reverts by itself on the device. Absent where a push is final.
   */
  confirm?(device: DeviceRef): Promise<CommandOutcome>;
  /** Copies the running configuration to startup so it survives a reload. A separate, explicit step. */
  save(device: DeviceRef): Promise<CommandOutcome>;
}

export type Inspectable = { ok: true } | { ok: false; reason: string };

export interface InventoryProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  listScopes(): Promise<Scope[]>;
  getTopology(scopeId: string, refresh?: boolean): Promise<Topology>;
  transport(scopeId: string): DeviceTransport;
  /** Whether a device can be read right now, with the reason when it cannot. */
  inspectable(node: TopoNode): Inspectable;
}

export function nodeRef(n: TopoNode): DeviceRef {
  return { id: n.id, label: n.label, kind: n.kind, platform: n.platform ?? "ios" };
}

/** `cml` for a bare id, otherwise the part before the first colon. */
export function splitScopeId(id: string): { providerId: string; local: string } {
  const i = id.indexOf(":");
  return i > 0 ? { providerId: id.slice(0, i), local: id.slice(i + 1) } : { providerId: "cml", local: id };
}
