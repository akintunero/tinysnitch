"use client";

import Link from "next/link";
import { claudeLabel, claudeTone, mcpTone, useApp } from "@/components/layout/status-provider";
import { PageHeader, StatusDot } from "@/components/ui/status-dot";
import { relativeTime } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <dt className="text-soft shrink-0 text-[13px]">{label}</dt>
      <dd className="min-w-0 text-right text-[13px]">{children}</dd>
    </div>
  );
}

export default function Overview() {
  const { status, settings, labs } = useApp();
  const mcp = status?.mcp;
  const claude = status?.claude;
  const lab = labs.labs.find((l) => l.id === settings?.selectedLabId);

  return (
    <>
      <PageHeader title="Overview" />
      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="conn">
          <h2 id="conn" className="mb-1 text-[13px] font-semibold">Connections</h2>
          <dl>
            <Row label="Cisco CML MCP"><StatusDot tone={mcpTone(mcp?.status)} label={mcp?.status ?? "checking"} /></Row>
            {mcp?.server ? <Row label="Server">{mcp.server.name} {mcp.server.version}</Row> : null}
            <Row label="Tools discovered">{mcp?.toolCount ?? 0}</Row>
            {mcp?.endpoint ? <Row label="Transport"><span className="font-mono text-[12px] break-all">{mcp.endpoint}</span></Row> : null}
            {mcp?.lastError ? <Row label="Last error"><span className="text-bad">{mcp.lastError}</span></Row> : null}
            {mcp && !mcp.configured ? <Row label="Configuration"><span className="text-bad">{mcp.configError}</span></Row> : null}
            <Row label="Claude API"><StatusDot tone={claudeTone(claude)} label={claudeLabel(claude)} /></Row>
            {claude?.model ? <Row label="Model"><span className="font-mono text-[12px]">{claude.model}</span></Row> : null}
            {claude && !claude.configured ? <Row label="Configuration"><span className="text-bad">{claude.configError}</span></Row> : null}
          </dl>
          <p className="text-soft mt-2 text-[12px]">Last MCP attempt: {relativeTime(mcp?.lastAttempt)}. <Link className="underline" href="/settings">Settings</Link></p>
        </section>

        <section aria-labelledby="lab">
          <h2 id="lab" className="mb-1 text-[13px] font-semibold">Current lab</h2>
          {lab ? (
            <dl>
              <Row label="Title">{lab.title}</Row>
              <Row label="State"><span className="font-mono text-[12px]">{lab.state}</span></Row>
              <Row label="Nodes">{lab.nodeCount ?? "-"}</Row>
              <Row label="Links">{lab.linkCount ?? "-"}</Row>
            </dl>
          ) : settings?.selectedLabTitle ? (
            <p className="text-soft text-[13px]">"{settings.selectedLabTitle}" was selected earlier{mcp?.status === "connected" ? ", but CML no longer lists it" : ", and will be checked once CML is connected"}. <Link className="underline" href="/labs">Choose a lab</Link></p>
          ) : (
            <p className="text-soft text-[13px]">No lab selected. <Link className="underline" href="/labs">Choose a lab</Link> to work on.</p>
          )}
          <p className="text-soft mt-6 text-[12px]">The topology, assistant, diagnostics and configuration workspaces are built in later phases and are listed in the sidebar.</p>
        </section>
      </div>
    </>
  );
}
