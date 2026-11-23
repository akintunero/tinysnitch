"use client";

import Link from "next/link";
import { useApp } from "@/components/layout/status-provider";
import { TopologyView } from "@/components/topology/topology-view";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

export default function Topology() {
  const { status, settings, labs } = useApp();

  if (!status || !settings) return <p className="text-soft">Loading...</p>;
  // Only a network that comes from CML needs the CML connection; an inventory, Ansible or NetBox network is read directly.
  const selected = labs.labs.find((l) => l.id === settings.selectedLabId);
  const needsCml = !selected || (selected.providerKind ?? "cml") === "cml";
  if (needsCml && settings.selectedLabId && status.mcp.status !== "connected") {
    return (
      <>
        <PageHeader title="Topology" />
        <EmptyState title="The MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the MCP server yet."} The topology is drawn from live data only.
        </EmptyState>
      </>
    );
  }
  if (!settings.selectedLabId) {
    return (
      <>
        <PageHeader title="Topology" />
        <EmptyState title="No network selected" action={<Link href="/networks" className="text-[13px] underline">Choose a network</Link>}>Pick a network to draw its devices and links.</EmptyState>
      </>
    );
  }
  return <TopologyView labId={settings.selectedLabId} />;
}
