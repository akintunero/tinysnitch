import { z } from "zod";
import type { Environment, Platform } from "../core/types";
import { CmlParseError } from "./labs";
import { type NodeKind, classifyNode } from "./node-types";

export type TopoInterface = { id: string; label: string; connected: boolean; ips: string[] };
export type TopoNode = {
  id: string;
  label: string;
  kind: NodeKind;
  definition: string;
  state: string;
  bootProgress: string | null;
  /** Which CLI dialect the device speaks. Absent means IOS, which is what every CML node here runs. */
  platform?: Platform;
  /** Management address, for providers that reach devices directly. */
  address?: string;
  x: number;
  y: number;
  interfaces: TopoInterface[];
};

/**
 * What can honestly be said about a link. CML only reports whether a link is plumbed (STARTED) or not, never
 * whether traffic passes, so "operational", "down" and "fault" are reserved for evidence from device inspection
 * (Phase 5). Until then a started link is "not_inspected", never green.
 */
export type LinkStatus = "operational" | "down" | "admin_down" | "unknown" | "fault" | "not_inspected";

export type TopoLink = {
  id: string;
  source: string; // node id
  target: string;
  sourceInterface: string;
  targetInterface: string;
  cmlState: string;
  status: LinkStatus;
  statusText: string;
};

export type Topology = {
  lab: { id: string; title: string; state: string; environment?: Environment; providerId?: string };
  nodes: TopoNode[];
  links: TopoLink[];
  fetchedAt: string;
  warnings: string[];
};

export function cmlLinkStatus(cmlState: string): { status: LinkStatus; text: string } {
  switch (cmlState.toUpperCase()) {
    case "STARTED":
      return { status: "not_inspected", text: "Up in CML; traffic not inspected yet" };
    case "STOPPED":
      return { status: "admin_down", text: "Stopped in CML" };
    case "DEFINED_ON_CORE":
      return { status: "unknown", text: "Lab not started" };
    default:
      return { status: "unknown", text: `CML state ${cmlState || "unknown"}` };
  }
}

const nodeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  node_definition: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  boot_progress: z.string().nullable().optional(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
});
const linkSchema = z.looseObject({
  id: z.string(),
  interface_a: z.string(),
  interface_b: z.string(),
  node_a: z.string(),
  node_b: z.string(),
  state: z.string().nullable().optional(),
});
const ifaceSchema = z.looseObject({ id: z.string(), label: z.string(), is_connected: z.boolean().optional() });

function items(text: string, what: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CmlParseError(`The ${what} reply was not JSON, so it was not used.`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && "result" in data) data = (data as { result: unknown }).result;
  return Array.isArray(data) ? data : data == null ? [] : [data];
}

function parseAll<T>(schema: z.ZodType<T>, text: string, what: string): T[] {
  return items(text, what).map((i) => {
    const r = schema.safeParse(i);
    if (!r.success) throw new CmlParseError(`An entry in the ${what} reply did not have the expected fields.`);
    return r.data;
  });
}

type RawNode = z.infer<typeof nodeSchema>;
type RawLink = z.infer<typeof linkSchema>;
type RawIface = z.infer<typeof ifaceSchema>;

export const parseNodes = (t: string): RawNode[] => parseAll(nodeSchema, t, "node");
export const parseLinks = (t: string): RawLink[] => parseAll(linkSchema, t, "link");
export const parseInterfaces = (t: string): RawIface[] => parseAll(ifaceSchema, t, "interface");

/** IPs are shown only when the server actually provides them under a recognisable field. */
function extractIps(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["ip4", "ipv4", "ip_addresses", "ip_address", "ip6", "ipv6"]) {
    const v = raw[key];
    if (typeof v === "string" && v) out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string" && x.length > 0));
  }
  return out;
}

export function buildTopology(
  lab: Topology["lab"],
  rawNodes: RawNode[],
  rawLinks: RawLink[],
  rawInterfaces: Map<string, RawIface[]>,
  warnings: string[] = [],
): Topology {
  const ifaceName = new Map<string, string>(); // interface id -> label, the source of truth for link ends
  const nodes: TopoNode[] = rawNodes.map((n) => {
    const ifaces = (rawInterfaces.get(n.id) ?? []).map((i) => {
      ifaceName.set(i.id, i.label);
      return { id: i.id, label: i.label, connected: i.is_connected === true, ips: extractIps(i) };
    });
    const definition = n.node_definition ?? "";
    return {
      id: n.id,
      label: n.label,
      kind: classifyNode(definition),
      definition,
      state: n.state ?? "UNKNOWN",
      bootProgress: n.boot_progress ?? null,
      x: n.x ?? 0,
      y: n.y ?? 0,
      interfaces: ifaces,
    };
  });
  const known = new Set(nodes.map((n) => n.id));
  const links: TopoLink[] = [];
  for (const l of rawLinks) {
    if (!known.has(l.node_a) || !known.has(l.node_b)) {
      warnings.push(`A link refers to a node that is not in this lab and was left out.`);
      continue;
    }
    const state = l.state ?? "UNKNOWN";
    const s = cmlLinkStatus(state);
    links.push({
      id: l.id,
      source: l.node_a,
      target: l.node_b,
      // CML link labels can be stale after renames, so names come from the interface ids.
      sourceInterface: ifaceName.get(l.interface_a) ?? "unknown interface",
      targetInterface: ifaceName.get(l.interface_b) ?? "unknown interface",
      cmlState: state,
      status: s.status,
      statusText: s.text,
    });
  }
  return { lab, nodes, links, fetchedAt: new Date().toISOString(), warnings };
}
