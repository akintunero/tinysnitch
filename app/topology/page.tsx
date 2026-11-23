"use client";

import Link from "next/link";
import { useApp } from "@/components/layout/status-provider";
import { TopologyView } from "@/components/topology/topology-view";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

export default function Topology() {
  const { status, settings } = useApp();

  if (!status || !settings) return <p className="text-soft">Loading...</p>;
  if (status.mcp.status !== "connected") {
    return (
      <>
        <PageHeader title="Topology" />
        <EmptyState title="The CML MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the CML MCP server yet."} The topology comes only from live CML data.
        </EmptyState>
      </>
    );
  }
  if (!settings.selectedLabId) {
    return (
      <>
        <PageHeader title="Topology" />
        <EmptyState title="No lab selected" action={<Link href="/labs" className="text-[13px] underline">Choose a lab</Link>}>Pick a lab to draw its nodes and links.</EmptyState>
      </>
    );
  }
  return <TopologyView labId={settings.selectedLabId} />;
}
