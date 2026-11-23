"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, type EdgeMouseHandler, type NodeChange, type NodeMouseHandler, type OnNodeDrag, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiagnosticsData } from "@/components/diagnostics/diagnostics-view";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/status-dot";
import { apiGet, apiSend, ClientError } from "@/lib/client";
import { KIND_LABEL, type NodeKind } from "@/lib/cml/node-types";
import type { Topology } from "@/lib/cml/topology";
import { cn, relativeTime } from "@/lib/utils";
import { type DeviceNode, DeviceNodeView } from "./device-node";
import { type LinkEdge, LinkEdgeView, STATUS_SHORT } from "./link-edge";
import { DevicePanel, LinkPanel } from "./panels";

const nodeTypes = { device: DeviceNodeView };
const edgeTypes = { link: LinkEdgeView };
type Selection = { type: "node" | "link"; id: string } | null;
type Pos = Record<string, { x: number; y: number }>;

function Canvas({ labId }: { labId: string }) {
  const [raw, setRaw] = useState<Topology | null>(null);
  const [diag, setDiag] = useState<DiagnosticsData | null>(null);
  const [saved, setSaved] = useState<Pos>({});
  const [positions, setPositions] = useState<Pos>({});
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [faultsOnly, setFaultsOnly] = useState(false);
  const rf = useReactFlow();
  const fitted = useRef<string | null>(null);
  const deepLinked = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const [t, p, d] = await Promise.all([
        apiGet<Topology>(`/api/labs/${labId}/topology${refresh ? "?refresh=1" : ""}`),
        apiGet<{ positions: Pos }>(`/api/labs/${labId}/positions`),
        apiGet<DiagnosticsData>(`/api/labs/${labId}/diagnostics`).catch(() => null), // colours are a bonus; the map works without them
      ]);
      setRaw(t);
      setDiag(d);
      setSaved(p.positions);
      setPositions(p.positions);
      setError(null);
    } catch (e) {
      setError({ message: (e as Error).message, code: e instanceof ClientError ? e.code : undefined });
    } finally {
      setLoading(false);
    }
  }, [labId]);

  useEffect(() => {
    setRaw(null);
    setDiag(null);
    setSelection(null);
    setHidden(new Set());
    setFaultsOnly(false);
    fitted.current = null;
    deepLinked.current = false;
    void load(false);
  }, [labId, load]);

  /** CML's own link state, overridden by what devices reported in the latest diagnostics run, where there is one. */
  const topology = useMemo<Topology | null>(() => {
    if (!raw) return null;
    return { ...raw, links: raw.links.map((l) => { const d = diag?.links[l.id]; return d ? { ...l, status: d.status, statusText: d.text } : l; }) };
  }, [raw, diag]);

  // Arriving from a finding (?finding=id) selects what it is about, once.
  useEffect(() => {
    if (deepLinked.current || !topology || !diag) return;
    const id = new URLSearchParams(window.location.search).get("finding");
    if (!id) return;
    deepLinked.current = true;
    const f = diag.findings.find((x) => x.id === id);
    if (f) setSelection(f.linkId ? { type: "link", id: f.linkId } : { type: "node", id: f.deviceId });
  }, [topology, diag]);

  const faulty = useMemo(() => {
    const nodes = new Set(Object.keys(diag?.nodeFaults ?? {}));
    const links = new Set((topology?.links ?? []).filter((l) => l.status === "fault" || l.status === "down").map((l) => l.id));
    for (const l of topology?.links ?? []) if (links.has(l.id)) { nodes.add(l.source); nodes.add(l.target); }
    return { nodes, links };
  }, [diag, topology]);

  const visible = useMemo(() => new Set((topology?.nodes ?? []).filter((n) => !hidden.has(n.kind)).map((n) => n.id)), [topology, hidden]);

  // The selected device and everything it connects to stay bright; the rest recede.
  const focus = useMemo(() => {
    if (!topology || !selection) return null;
    const ids = new Set<string>();
    if (selection.type === "node") {
      ids.add(selection.id);
      for (const l of topology.links) { if (l.source === selection.id) ids.add(l.target); if (l.target === selection.id) ids.add(l.source); }
    } else {
      const l = topology.links.find((x) => x.id === selection.id);
      if (l) { ids.add(l.source); ids.add(l.target); }
    }
    return ids;
  }, [topology, selection]);

  const nodes = useMemo<DeviceNode[]>(() => (topology?.nodes ?? []).filter((n) => visible.has(n.id)).map((n) => ({
    id: n.id,
    type: "device",
    position: positions[n.id] ?? { x: n.x, y: n.y },
    selected: selection?.type === "node" && selection.id === n.id,
    ariaLabel: `${n.label}, ${KIND_LABEL[n.kind]}, ${n.state.toLowerCase()}${diag?.nodeFaults[n.id] ? `, ${diag.nodeFaults[n.id] === "error" ? "fault detected" : "warning"}` : ""}`,
    data: {
      label: n.label, kind: n.kind, definition: n.definition, state: n.state, interfaceCount: n.interfaces.length, selected: selection?.type === "node" && selection.id === n.id,
      fault: diag?.nodeFaults[n.id],
      dimmed: (!!focus && !focus.has(n.id)) || (faultsOnly && !faulty.nodes.has(n.id)),
    },
  })), [topology, visible, positions, selection, focus, diag, faultsOnly, faulty]);

  const edges = useMemo<LinkEdge[]>(() => {
    const links = (topology?.links ?? []).filter((l) => visible.has(l.source) && visible.has(l.target));
    const group = (a: string, b: string) => [a, b].sort().join("|");
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const l of links) counts.set(group(l.source, l.target), (counts.get(group(l.source, l.target)) ?? 0) + 1);
    return links.map((l) => {
      const g = group(l.source, l.target);
      const index = seen.get(g) ?? 0;
      seen.set(g, index + 1);
      const isSel = selection?.type === "link" && selection.id === l.id;
      const touches = selection?.type === "node" && (l.source === selection.id || l.target === selection.id);
      return {
        id: l.id, type: "link", source: l.source, target: l.target, selected: isSel,
        ariaLabel: `Link from ${l.sourceInterface} to ${l.targetInterface}, ${STATUS_SHORT[l.status]}`,
        data: { status: l.status, statusText: l.statusText, sourceInterface: l.sourceInterface, targetInterface: l.targetInterface, index, count: counts.get(g) ?? 1, selected: isSel,
          dimmed: (!!selection && !isSel && !touches) || (faultsOnly && !faulty.links.has(l.id)) },
      };
    });
  }, [topology, visible, selection, faultsOnly, faulty]);

  useEffect(() => {
    if (topology && fitted.current !== topology.lab.id && nodes.length) {
      fitted.current = topology.lab.id;
      requestAnimationFrame(() => void rf.fitView({ padding: 0.2 }));
    }
  }, [topology, nodes.length, rf]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPositions((p) => {
      let next = p;
      for (const c of changes) if (c.type === "position" && c.position) next = { ...next, [c.id]: c.position };
      return next;
    });
  }, []);
  const onNodeDragStop: OnNodeDrag<DeviceNode> = useCallback((_e, node) => {
    void apiSend("PUT", `/api/labs/${labId}/positions`, { positions: { [node.id]: node.position } }).catch(() => undefined);
    setSaved((s) => ({ ...s, [node.id]: node.position }));
  }, [labId]);

  const resetLayout = async () => {
    try { await apiSend("DELETE", `/api/labs/${labId}/positions`); } catch { /* keep going: the local reset still helps */ }
    setSaved({});
    setPositions({});
    requestAnimationFrame(() => void rf.fitView({ padding: 0.2 }));
  };

  const kinds = useMemo(() => [...new Set((topology?.nodes ?? []).map((n) => n.kind))], [topology]);
  const toggle = (k: NodeKind) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const moved = Object.keys(saved).length > 0;
  const hasFindings = (diag?.findings.length ?? 0) > 0;

  if (error && !topology) {
    return (
      <EmptyState title={error.code === "capability_missing" ? "This CML server cannot supply the topology" : "Could not load the topology"} action={<Button onClick={() => void load(true)}>Try again</Button>}>
        {error.message}
      </EmptyState>
    );
  }
  if (!topology) return <p className="text-soft">Loading the topology from CML...</p>;
  if (!topology.nodes.length) return <EmptyState title="This lab has no nodes" action={<Button onClick={() => void load(true)}>Refresh</Button>}>CML reports a lab named "{topology.lab.title}" with nothing in it.</EmptyState>;

  const selNode = selection?.type === "node" ? topology.nodes.find((n) => n.id === selection.id) : undefined;
  const selLink = selection?.type === "link" ? topology.links.find((l) => l.id === selection.id) : undefined;
  const findings = diag?.findings ?? [];
  const onNodeClick: NodeMouseHandler = (_e, n) => setSelection({ type: "node", id: n.id });
  const onEdgeClick: EdgeMouseHandler = (_e, l) => setSelection({ type: "link", id: l.id });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold tracking-tight">{topology.lab.title}</h1>
          <p className="text-soft text-[12px]">
            {topology.nodes.length} nodes, {topology.links.length} links · lab {topology.lab.state.toLowerCase().replace(/_/g, " ")} · read {new Date(topology.fetchedAt).toLocaleTimeString()}
            {diag?.run ? ` · link states from the diagnostics run ${relativeTime(diag.run.finishedAt)}` : <> · links not inspected yet, <Link className="underline" href="/diagnostics">run diagnostics</Link></>}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Show device types" className="flex flex-wrap gap-1">
            {kinds.map((k) => (
              <button key={k} type="button" aria-pressed={!hidden.has(k)} onClick={() => toggle(k)}
                className={cn("h-7 rounded-sm border px-2 text-[12px]", hidden.has(k) ? "border-line text-muted line-through" : "border-ink bg-surface text-ink")}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {hasFindings || faulty.nodes.size ? (
            <button type="button" aria-pressed={faultsOnly} onClick={() => setFaultsOnly((v) => !v)}
              className={cn("h-7 rounded-sm border px-2 text-[12px]", faultsOnly ? "border-bad bg-surface text-bad" : "border-line text-ink")}>Highlight faults</button>
          ) : null}
          <Button onClick={() => void rf.fitView({ padding: 0.2 })}>Fit</Button>
          <Button onClick={() => void resetLayout()} disabled={!moved && Object.keys(positions).length === 0}>Reset layout</Button>
          <Button onClick={() => void load(true)} disabled={loading}>{loading ? "Refreshing" : "Refresh"}</Button>
        </div>
      </div>
      {error ? <p role="alert" className="mb-2 text-[13px] text-bad">Refresh failed, showing the last good read: {error.message}</p> : null}
      {topology.warnings.length ? <p className="text-soft mb-2 text-[12px]">{topology.warnings.join(" ")}</p> : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-bg md:flex-row">
        <div className="min-h-[24rem] min-w-0 flex-1">
          <ReactFlow<DeviceNode, LinkEdge>
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={() => setSelection(null)}
            nodesConnectable={false} elementsSelectable minZoom={0.15} maxZoom={2.5} proOptions={{ hideAttribution: true }} colorMode="light"
          >
            <Background gap={24} size={1} color="#D8D7D1" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
        {selNode ? <DevicePanel node={selNode} topology={topology} findings={findings.filter((f) => f.deviceId === selNode.id)} onSelectNode={(id) => setSelection({ type: "node", id })} onSelectLink={(id) => setSelection({ type: "link", id })} onClose={() => setSelection(null)} /> : null}
        {selLink ? <LinkPanel link={selLink} topology={topology} findings={findings.filter((f) => f.linkId === selLink.id)} onSelectNode={(id) => setSelection({ type: "node", id })} onClose={() => setSelection(null)} /> : null}
      </div>

      <ul className="text-soft mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]" aria-label="Legend">
        {([["Not yet inspected", "bg-muted"], ["Administratively down", "bg-warn"], ["Unknown", "bg-muted/60"], ["Operational (both ends up/up)", "bg-ok"], ["Down or fault", "bg-bad"]] as const).map(([t, c]) => (
          <li key={t} className="flex items-center gap-1.5"><span aria-hidden className={cn("h-0.5 w-5", c)} />{t}</li>
        ))}
        <li>Operational, down and fault come from the latest diagnostics run</li>
      </ul>
    </div>
  );
}

export function TopologyView({ labId }: { labId: string }) {
  return <ReactFlowProvider><Canvas labId={labId} /></ReactFlowProvider>;
}
