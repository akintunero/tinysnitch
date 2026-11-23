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
        <EmptyState title="The CML MCP connection needs attention" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.mcp.configError ?? status.mcp.lastError ?? "Tiny Snitch is not connected to the CML MCP server yet."} The assistant answers only from live CML data, so it stays off until the connection is up.
        </EmptyState>
      </>
    );
  }
  if (!status.claude.configured) {
    return (
      <>
        <PageHeader title="Network Assistant" />
        <EmptyState title="Claude is not configured" action={<Link href="/settings" className="text-[13px] underline">Open Settings</Link>}>
          {status.claude.configError ?? "Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL in .env.local and restart."}
        </EmptyState>
      </>
    );
  }
  return <ChatView />;
}
