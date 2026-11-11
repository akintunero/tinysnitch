import type { LinkStatus, Topology } from "../cml/topology";
import { normIf } from "./parsers";
import type { Finding, RunSummary } from "./types";

export type DerivedLink = { status: LinkStatus; text: string };
export type NodeFault = "warning" | "error";

// Findings about the interface itself are already expressed by the link's down / admin-down state.
const INTERFACE_KINDS = new Set(["interface-admin-down", "interface-down"]);

/**
 * Link colours and node flags from what devices reported. "operational" means both ends said up/up (and says so
 * in its text, with ping evidence when there is some). A link with no observation for either end is left out, so
 * the topology keeps what CML alone can say about it.
 */
export function deriveFromRun(topology: Topology, run: RunSummary | null, findings: Finding[]): { links: Record<string, DerivedLink>; nodeFaults: Record<string, NodeFault> } {
  const links: Record<string, DerivedLink> = {};
  const nodeFaults: Record<string, NodeFault> = {};
  if (!run) return { links, nodeFaults };

  for (const f of findings) {
    const level: NodeFault | null = f.severity === "critical" ? (f.status === "confirmed" ? "error" : "warning") : f.severity === "warning" ? "warning" : null;
    if (level && nodeFaults[f.deviceId] !== "error") nodeFaults[f.deviceId] = level;
  }

  const label = new Map(topology.nodes.map((n) => [n.id, n.label]));
  for (const l of topology.links) {
    const a = run.interfaces[l.source]?.[normIf(l.sourceInterface)];
    const b = run.interfaces[l.target]?.[normIf(l.targetInterface)];
    if (!a && !b) continue;
    const ends = [
      { o: a, name: `${label.get(l.source)} ${normIf(l.sourceInterface)}` },
      { o: b, name: `${label.get(l.target)} ${normIf(l.targetInterface)}` },
    ];
    const shut = ends.find((e) => e.o?.status === "administratively down");
    const down = ends.find((e) => e.o && (e.o.status === "down" || e.o.protocol === "down"));
    const linkFindings = findings.filter((f) => f.linkId === l.id && !INTERFACE_KINDS.has(f.kind));
    const confirmed = linkFindings.find((f) => f.status === "confirmed" && f.severity !== "info");
    const suspected = linkFindings.find((f) => f.status === "suspected");
    const ping = run.pings.find((p) => p.linkId === l.id);

    if (shut) links[l.id] = { status: "admin_down", text: `${shut.name} is administratively down` };
    else if (down) links[l.id] = { status: "down", text: `${down.name} reports ${down.o!.status}/${down.o!.protocol}` };
    else if (confirmed) links[l.id] = { status: "fault", text: confirmed.title };
    else if (a && b) {
      const parts = ["Both ends report up/up"];
      if (ping) parts.push(ping.ok ? "ping between them succeeded" : "ping between them did not fully succeed");
      if (suspected) parts.push(`suspected: ${suspected.title.toLowerCase()}`);
      links[l.id] = { status: ping && !ping.ok ? "fault" : "operational", text: parts.join("; ") };
    } else {
      const seen = a ?? b!;
      links[l.id] = { status: "not_inspected", text: `One end reports ${seen.status}/${seen.protocol}; the device at the other end was not inspected` };
    }
  }
  return { links, nodeFaults };
}
