"use client";

import Link from "next/link";
import { ChatView } from "@/components/assistant/chat-view";
import { useApp } from "@/components/layout/status-provider";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";

export default function Assistant() {
  const { status } = useApp();
  if (!status) return <p className="text-soft">Loading...</p>;

  if (status.mcp.status !== "connected") {
    return (
      <>
        <PageHeader title="Network Assistant" />
        <EmptyState title="The MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the MCP server yet."} The assistant answers only from live network data, so it stays off until the connection is up.
        </EmptyState>
      </>
    );
  }
  if (!status.claude.configured) {
    return (
      <>
        <PageHeader title="Network Assistant" />
        <EmptyState title="No AI model is configured" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.claude.configError ?? "Choose a model in .env.local (see .env.example) and restart."}
        </EmptyState>
      </>
    );
  }
  return <ChatView />;
}
