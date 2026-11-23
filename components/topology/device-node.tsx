"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { BrickWall, Box, Cable, Layers, Monitor, Network, Router, Server, Terminal } from "lucide-react";
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
  /** Set by diagnostics (Phase 5). Nothing sets it yet, so nothing is flagged until there is evidence. */
  fault?: "warning" | "error";
  [key: string]: unknown;
};
export type DeviceNode = Node<DeviceData, "device">;

const ICON: Record<NodeKind, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  router: Router, l2switch: Network, l3switch: Layers, firewall: BrickWall, server: Server, host: Terminal, pc: Monitor, connector: Cable, other: Box,
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
