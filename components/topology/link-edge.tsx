"use client";

import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { LinkStatus } from "@/lib/cml/topology";
import { cn } from "@/lib/utils";

export type LinkData = {
  status: LinkStatus;
  statusText: string;
  sourceInterface: string;
  targetInterface: string;
  /** Position among parallel links between the same two nodes, so they fan out instead of overlapping. */
  index: number;
  count: number;
  dimmed: boolean;
  selected: boolean;
  [key: string]: unknown;
};
export type LinkEdge = Edge<LinkData, "link">;

// Half the rendered size of a device node (w-36 = 144px wide, about 76px tall).
const NODE_HALF_W = 72;
const NODE_HALF_H = 38;

export const STATUS_SHORT: Record<LinkStatus, string> = {
  operational: "Operational",
  down: "Down",
  admin_down: "Administratively down",
  unknown: "Unknown",
  fault: "Fault detected",
  not_inspected: "Not yet inspected",
};

/** Colour is never the only signal: each status also has its own line pattern. */
const STROKE: Record<LinkStatus, string> = {
  operational: "stroke-ok [stroke-width:2.5]",
  down: "stroke-bad [stroke-width:2.5] [stroke-dasharray:7_5]",
  admin_down: "stroke-warn [stroke-width:2.5] [stroke-dasharray:2_4_9_4]",
  unknown: "stroke-muted [stroke-width:2] [stroke-dasharray:2_5]",
  fault: "stroke-bad [stroke-width:4]",
  not_inspected: "stroke-muted [stroke-width:2]",
};

const shortIf = (n: string) => n.replace("TenGigabitEthernet", "Te").replace("GigabitEthernet", "Gi").replace("FastEthernet", "Fa").replace("Ethernet", "Eth").replace("Loopback", "Lo");

export function LinkEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<LinkEdge>) {
  if (!data) return null;
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = (data.index - (data.count - 1) / 2) * 44;
  const cx = mx + nx * offset * 2; // control point; the curve passes through `offset` at its middle
  const cy = my + ny * offset * 2;
  const path = offset === 0 ? `M ${sourceX},${sourceY} L ${targetX},${targetY}` : `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;
  const at = (t: number): [number, number] => [
    (1 - t) ** 2 * sourceX + 2 * (1 - t) * t * cx + t * t * targetX,
    (1 - t) ** 2 * sourceY + 2 * (1 - t) * t * cy + t * t * targetY,
  ];
  // Interface labels sit just outside each node's box (not at a fixed fraction, which lands under the box on
  // short links), and are nudged to opposite sides of the line so two labels on a short link don't collide.
  const ux = dx / len;
  const uy = dy / len;
  const exit = Math.min(NODE_HALF_W / (Math.abs(ux) || 1e-9), NODE_HALF_H / (Math.abs(uy) || 1e-9));
  const t1 = Math.min(0.45, (exit + 22) / len);
  const nudge = offset === 0 ? 10 : 0;
  const [sx, sy] = offset === 0 ? [sourceX + dx * t1 + nx * nudge, sourceY + dy * t1 + ny * nudge] : at(t1);
  const [tx, ty] = offset === 0 ? [sourceX + dx * (1 - t1) - nx * nudge, sourceY + dy * (1 - t1) - ny * nudge] : at(1 - t1);
  const [lx, ly] = offset === 0 ? [mx, my] : at(0.5);
  const showStatus = data.selected || data.status === "fault";

  const tag = "pointer-events-none absolute rounded-sm bg-bg/90 px-1 font-mono text-[10px] text-soft";
  return (
    <>
      {data.selected ? <BaseEdge id={`${id}-halo`} path={path} className="stroke-ink/15 [stroke-width:9]" interactionWidth={0} /> : null}
      <BaseEdge id={id} path={path} className={cn(STROKE[data.status], data.dimmed && "opacity-25")} interactionWidth={16} />
      <EdgeLabelRenderer>
        <div className={cn(tag, data.dimmed && "opacity-25")} style={{ transform: `translate(-50%, -50%) translate(${sx}px, ${sy}px)` }}>{shortIf(data.sourceInterface)}</div>
        <div className={cn(tag, data.dimmed && "opacity-25")} style={{ transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px)` }}>{shortIf(data.targetInterface)}</div>
        {showStatus ? (
          <div className={cn(tag, "border border-line bg-surface font-sans font-medium text-ink")} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {STATUS_SHORT[data.status]}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}
