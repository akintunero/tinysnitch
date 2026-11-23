"use client";

import Link from "next/link";
import { DiagnosticsView } from "@/components/diagnostics/diagnostics-view";
import { useApp } from "@/components/layout/status-provider";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

export default function Diagnostics() {
  const { status, settings, labs } = useApp();
  if (!status || !settings) return <p className="text-soft">Loading...</p>;

  // Only a network that comes from CML needs the CML connection; an inventory, Ansible or NetBox network is read directly.
  const selected = labs.labs.find((l) => l.id === settings.selectedLabId);
  const needsCml = !selected || (selected.providerKind ?? "cml") === "cml";
  if (needsCml && settings.selectedLabId && status.mcp.status !== "connected") {
    return (
      <>
        <PageHeader title="Diagnostics" />
        <EmptyState title="The MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the MCP server yet."} Diagnostics read live devices, so they need it.
        </EmptyState>
      </>
    );
  }
  if (!settings.selectedLabId) {
    return (
      <>
        <PageHeader title="Diagnostics" />
        <EmptyState title="No network selected" action={<Link href="/networks" className="text-[13px] underline">Choose a network</Link>}>Pick a network to check its running devices.</EmptyState>
      </>
    );
  }
  const title = labs.labs.find((l) => l.id === settings.selectedLabId)?.title ?? settings.selectedLabTitle;
  return <DiagnosticsView labId={settings.selectedLabId} labTitle={title} />;
}
