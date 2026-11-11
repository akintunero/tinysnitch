"use client";

import Link from "next/link";
import { DiagnosticsView } from "@/components/diagnostics/diagnostics-view";
import { useApp } from "@/components/layout/status-provider";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

export default function Diagnostics() {
  const { status, settings, labs } = useApp();
  if (!status || !settings) return <p className="text-soft">Loading...</p>;

  if (status.mcp.status !== "connected") {
    return (
      <>
        <PageHeader title="Diagnostics" />
        <EmptyState title="The CML MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the CML MCP server yet."} Diagnostics read live devices, so they need the connection.
        </EmptyState>
      </>
    );
  }
  if (!settings.selectedLabId) {
    return (
      <>
        <PageHeader title="Diagnostics" />
        <EmptyState title="No lab selected" action={<Link href="/labs" className="text-[13px] underline">Choose a lab</Link>}>Pick a lab to check its running devices.</EmptyState>
      </>
    );
  }
  const title = labs.labs.find((l) => l.id === settings.selectedLabId)?.title ?? settings.selectedLabTitle;
  return <DiagnosticsView labId={settings.selectedLabId} labTitle={title} />;
}
