"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { StatusDot } from "@/components/ui/status-dot";
import type { StoredFinding } from "@/lib/diagnostics/store";
import { cn } from "@/lib/utils";
import { KIND_LABEL } from "@/lib/cml/node-types";
import type { TopoLink, TopoNode, Topology } from "@/lib/cml/topology";
import { STATUS_SHORT } from "./link-edge";
import { nodeStateView } from "./device-node";

function Shell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside aria-label={title} className="w-full shrink-0 overflow-auto border-t border-line bg-surface p-4 md:w-80 md:border-l md:border-t-0">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold">{title}</h2>
          {subtitle ? <p className="text-soft truncate font-mono text-[11px]">{subtitle}</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-sm p-1 hover:bg-surface-2"><X className="size-4 text-muted" aria-hidden /></button>
      </div>
      {children}
    </aside>
  );
}

const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-1 mt-4 text-[12px] font-semibold text-soft">{children}</h3>;

const SEV = { critical: "text-bad", warning: "text-warn", info: "text-soft" } as const;

function Findings({ findings }: { findings: StoredFinding[] }) {
  if (!findings.length) return <p className="text-soft text-[12px]">No open findings from the latest run.</p>;
  return (
    <ul className="space-y-1.5 text-[12px]">
      {findings.map((f) => (
        <li key={f.id}>
          <Link href={`/diagnostics`} className="underline decoration-line underline-offset-2 hover:decoration-ink">{f.title}</Link>
          <span className={cn("ml-1.5 text-[10px] font-semibold uppercase", SEV[f.severity])}>{f.severity}</span>
          <span className="text-soft ml-1 text-[10px] uppercase">{f.status}</span>
          <div className="text-soft">{f.interface ?? ""} {f.probableCause}</div>
        </li>
      ))}
    </ul>
  );
}

export function DevicePanel({ node, topology, findings, onSelectNode, onSelectLink, onClose }: {
  node: TopoNode; topology: Topology; findings: StoredFinding[]; onSelectNode: (id: string) => void; onSelectLink: (id: string) => void; onClose: () => void;
}) {
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const mine = topology.links.filter((l) => l.source === node.id || l.target === node.id);
  const across = (l: TopoLink) => (l.source === node.id ? { peer: byId.get(l.target), mine: l.sourceInterface, theirs: l.targetInterface } : { peer: byId.get(l.source), mine: l.targetInterface, theirs: l.sourceInterface });
  const byInterface = new Map(mine.map((l) => [across(l).mine, l]));
  const neighbours = [...new Map(mine.map((l) => { const p = across(l).peer; return [p?.id ?? l.id, p] as const; })).values()].filter((p): p is TopoNode => !!p);
  const s = nodeStateView(node.state);

  return (
    <Shell title={node.label} subtitle={`${KIND_LABEL[node.kind]} · ${node.definition || "unknown definition"}`} onClose={onClose}>
      <dl className="text-[13px]">
        <div className="flex justify-between py-0.5"><dt className="text-soft">State</dt><dd><StatusDot tone={s.tone} label={s.label} /></dd></div>
        {node.bootProgress ? <div className="flex justify-between py-0.5"><dt className="text-soft">Boot</dt><dd>{node.bootProgress}</dd></div> : null}
        <div className="flex justify-between py-0.5"><dt className="text-soft">Interfaces</dt><dd>{node.interfaces.length} ({node.interfaces.filter((i) => i.connected).length} connected)</dd></div>
      </dl>

      <H>Interfaces</H>
      {node.interfaces.length ? (
        <ul className="divide-y divide-line text-[12px]">
          {node.interfaces.map((i) => {
            const l = byInterface.get(i.label);
            const a = l ? across(l) : null;
            return (
              <li key={i.id} className="py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono">{i.label}</span>
                  <span className="text-soft">{i.connected ? "connected" : "not connected"}</span>
                </div>
                {i.ips.length ? <div className="font-mono text-[11px]">{i.ips.join(", ")}</div> : null}
                {l && a?.peer ? (
                  <button type="button" onClick={() => onSelectLink(l.id)} className="text-soft hover:text-ink mt-0.5 text-left text-[11px] underline decoration-line underline-offset-2">
                    to {a.peer.label} {a.theirs}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="text-soft text-[12px]">CML returned no interfaces for this node.</p>}
      {node.interfaces.every((i) => i.ips.length === 0) ? <p className="text-soft mt-1 text-[11px]">IP addresses are not reported by CML for these interfaces. They come from device inspection (Phase 5).</p> : null}

      <H>Neighbours</H>
      {neighbours.length ? (
        <ul className="text-[13px]">
          {neighbours.map((n) => <li key={n.id}><button type="button" className="py-0.5 underline decoration-line underline-offset-2 hover:decoration-ink" onClick={() => onSelectNode(n.id)}>{n.label}</button> <span className="text-soft text-[11px]">{KIND_LABEL[n.kind]}</span></li>)}
        </ul>
      ) : <p className="text-soft text-[12px]">No links to other nodes.</p>}

      <H>Diagnostics</H>
      <Findings findings={findings} />
      <p className="text-soft mt-1 text-[11px]">Routing tables and adjacencies are read from running devices by the <Link className="underline" href="/diagnostics">diagnostics run</Link>.</p>
      <H>Operations</H>
      <p className="text-soft text-[12px]">Configuration operations arrive in Phase 6 and will always ask for approval.</p>
    </Shell>
  );
}

export function LinkPanel({ link, topology, findings, onSelectNode, onClose }: { link: TopoLink; topology: Topology; findings: StoredFinding[]; onSelectNode: (id: string) => void; onClose: () => void }) {
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const end = (id: string, iface: string, label: string) => {
    const n = byId.get(id);
    return (
      <div className="border-b border-line py-2 last:border-0">
        <div className="text-soft text-[11px]">{label}</div>
        {n ? <button type="button" onClick={() => onSelectNode(n.id)} className="text-[13px] font-medium underline decoration-line underline-offset-2 hover:decoration-ink">{n.label}</button> : <span>unknown node</span>}
        <div className="font-mono text-[12px]">{iface}</div>
      </div>
    );
  };
  return (
    <Shell title="Link" subtitle={`${byId.get(link.source)?.label ?? "?"} to ${byId.get(link.target)?.label ?? "?"}`} onClose={onClose}>
      {end(link.source, link.sourceInterface, "Endpoint A")}
      {end(link.target, link.targetInterface, "Endpoint B")}
      <H>Status</H>
      <p className="text-[13px] font-medium">{STATUS_SHORT[link.status]}</p>
      <p className="text-soft text-[12px]">{link.statusText}. CML state: <span className="font-mono">{link.cmlState}</span>.</p>
      {link.status === "not_inspected" || link.status === "unknown" ? (
        <p className="text-soft mt-2 text-[12px]">CML does not report whether traffic passes over a link. A link is shown as operational, down or faulty only once a <Link className="underline" href="/diagnostics">diagnostics run</Link> has read its endpoints.</p>
      ) : <p className="text-soft mt-2 text-[12px]">This state comes from what the devices reported in the latest diagnostics run.</p>}
      <H>Findings</H>
      <Findings findings={findings} />
    </Shell>
  );
}
