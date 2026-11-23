"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { BrickWall, Box, Cable, Monitor, Server, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { StatusDot, type Tone } from "@/components/ui/status-dot";
import type { NodeKind } from "@/lib/cml/node-types";
import { cn } from "@/lib/utils";

export type DeviceData = {
  label: string;
  kind: NodeKind;
  definition: string;
  state: string;
  interfaceCount: number;
  dimmed: boolean;
  selected: boolean;
  /** Set from the latest diagnostics run. Nothing is flagged without evidence. */
  fault?: "warning" | "error";
  [key: string]: unknown;
};
export type DeviceNode = Node<DeviceData, "device">;

type GlyphProps = { className?: string; strokeWidth?: number };

/** The conventional diagram symbols: a router is a circle with arrows in and out; a switch is a box with arrows across it. */
const Arrows = () => (
  <path d="M12 7V3m0 0-1.5 1.5M12 3l1.5 1.5M12 17v4m0 0-1.5-1.5M12 21l1.5-1.5M7 12H3m0 0 1.5-1.5M3 12l1.5 1.5M17 12h4m0 0-1.5-1.5M21 12l-1.5 1.5" />
);
const RouterGlyph = ({ className, strokeWidth = 1.75 }: GlyphProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <circle cx="12" cy="12" r="5" /><Arrows />
  </svg>
);
const SwitchGlyph = ({ className, strokeWidth = 1.75 }: GlyphProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 10.5h10m-2.5-2 2.5 2-2.5 2M17 13.5H7m2.5-2-2.5 2 2.5 2" />
  </svg>
);
const L3SwitchGlyph = ({ className, strokeWidth = 1.75 }: GlyphProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="3" y="7" width="18" height="10" rx="1.5" /><circle cx="12" cy="12" r="2.5" />
  </svg>
);

const ICON: Record<NodeKind, ComponentType<GlyphProps>> = {
  router: RouterGlyph, l2switch: SwitchGlyph, l3switch: L3SwitchGlyph, firewall: BrickWall, server: Server, host: Terminal, pc: Monitor, connector: Cable, other: Box,
};

export function nodeStateView(state: string): { tone: Tone; label: string } {
  switch (state.toUpperCase()) {
    case "BOOTED": return { tone: "ok", label: "running" };
    case "STARTED":
    case "BOOTING": return { tone: "warn", label: "starting" };
    case "STOPPED": return { tone: "idle", label: "stopped" };
    case "DEFINED_ON_CORE":
    case "CREATED": return { tone: "idle", label: "not started" };
    default: return { tone: "idle", label: state.toLowerCase() };
  }
}

export function DeviceNodeView({ data }: NodeProps<DeviceNode>) {
  const Icon = ICON[data.kind];
  const s = nodeStateView(data.state);
  return (
    <div
      className={cn(
        "w-36 rounded-md border bg-surface px-2.5 py-2 text-left transition-opacity",
        data.selected ? "border-ink shadow-[0_0_0_2px_var(--color-surface-2)]" : "border-line",
        data.kind === "connector" && "border-dashed",
        data.fault === "error" && "border-l-4 border-l-bad",
        data.fault === "warning" && "border-l-4 border-l-warn",
        data.dimmed && "opacity-30",
      )}
    >
      {/* One invisible handle at the centre so links run centre to centre. */}
      <Handle type="target" position={Position.Top} className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent" style={{ top: "50%", left: "50%" }} />
      <Handle type="source" position={Position.Top} className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent" style={{ top: "50%", left: "50%" }} />
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-ink" strokeWidth={1.75} />
        <span className="truncate text-[13px] font-medium">{data.label}</span>
      </div>
      <div className="text-soft mt-0.5 truncate font-mono text-[10px]">{data.definition || data.kind}</div>
      <div className="mt-1 flex items-center justify-between">
        <StatusDot tone={s.tone} label={s.label} />
        {data.interfaceCount ? <span className="text-soft text-[10px]">{data.interfaceCount} if</span> : null}
      </div>
    </div>
  );
}
