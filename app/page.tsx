"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { claudeLabel, claudeTone, mcpTone, useApp } from "@/components/layout/status-provider";
import { EmptyState, PageHeader, StatusDot } from "@/components/ui/status-dot";
import { apiGet } from "@/lib/client";
import type { Finding, RunSummary } from "@/lib/diagnostics/types";
import { relativeTime } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <dt className="text-soft shrink-0 text-[13px]">{label}</dt>
      <dd className="min-w-0 text-right text-[13px]">{children}</dd>
    </div>
  );
}

type HealthData = { run: RunSummary | null; findings: Finding[] };

/** What the latest saved diagnostics run says about the selected network. Reads saved results only; it never touches a device. */
function Health({ networkId }: { networkId: string }) {
  const [data, setData] = useState<HealthData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setData(null);
    setFailed(false);
    apiGet<HealthData>(`/api/labs/${encodeURIComponent(networkId)}/diagnostics`).then(setData).catch(() => setFailed(true));
  }, [networkId]);

  if (failed) return <p className="text-soft text-[13px]">The latest results could not be read.</p>;
  if (!data) return <p className="text-soft text-[13px]">Reading the latest results…</p>;
  if (!data.run) {
    return (
      <EmptyState title="Not checked yet" action={<Link href="/diagnostics" className="text-[13px] underline">Run diagnostics</Link>}>
        Nothing is known about this network's health until a check has run.
      </EmptyState>
    );
  }
  const { run, findings } = data;
  const count = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  const inspected = run.devices.filter((d) => d.inspected).length;
  const cells: { label: string; value: number; tone: string }[] = [
    { label: "Critical", value: count("critical"), tone: count("critical") ? "text-bad" : "" },
    { label: "Warning", value: count("warning"), tone: count("warning") ? "text-warn" : "" },
    { label: "Info", value: count("info"), tone: "" },
  ];
  const worst = [...findings].sort((a, b) => ["critical", "warning", "info"].indexOf(a.severity) - ["critical", "warning", "info"].indexOf(b.severity)).slice(0, 5);
  return (
    <>
      <dl className="grid grid-cols-3 gap-4 border-b border-line pb-3">
        {cells.map((c) => (
          <div key={c.label}>
            <dt className="text-soft text-[12px]">{c.label}</dt>
            <dd className={`font-mono text-[22px] tabular-nums ${c.tone}`}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-soft mt-2 text-[12px]">
        Checked {relativeTime(run.finishedAt)}: {inspected} of {run.devices.length} devices read
        {run.notRun.length ? `, ${run.notRun.length} checks not run` : ""}.
      </p>
      {worst.length ? (
        <table className="mt-3 w-full text-[13px]">
          <tbody>
            {worst.map((f) => (
              <tr key={f.id} className="border-b border-line last:border-0">
                <td className="w-24 py-1.5 pr-3 font-mono text-[12px]">{f.device}</td>
                <td className="py-1.5">{f.title}</td>
                <td className={`w-20 py-1.5 pl-3 text-right text-[12px] ${f.severity === "critical" ? "text-bad" : f.severity === "warning" ? "text-warn" : "text-soft"}`}>{f.status === "suspected" ? "suspected" : f.severity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-soft mt-3 text-[13px]">No findings on the devices that could be read.</p>
      )}
      <p className="mt-2 text-[12px]"><Link className="underline" href="/diagnostics">All findings</Link></p>
    </>
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
      {lab ? (
        <section aria-labelledby="health" className="mb-8">
          <h2 id="health" className="label mb-2">Health <span className="font-mono normal-case tracking-normal">{lab.title}</span></h2>
          <Health networkId={lab.id} />
        </section>
      ) : null}
      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="conn">
          <h2 id="conn" className="label mb-1">Connections</h2>
          <dl>
            <Row label="MCP server (simulators)"><StatusDot tone={mcp && !mcp.configured ? "idle" : mcpTone(mcp?.status)} label={mcp && !mcp.configured ? "not configured" : (mcp?.status ?? "checking")} /></Row>
            {mcp?.server ? <Row label="Server">{mcp.server.name} {mcp.server.version}</Row> : null}
            <Row label="Tools discovered">{mcp?.toolCount ?? 0}</Row>
            {mcp?.endpoint ? <Row label="Transport"><span className="block text-left font-mono text-[12px] [overflow-wrap:anywhere]">{mcp.endpoint}</span></Row> : null}
            {mcp?.lastError ? <Row label="Last error"><span className="text-bad">{mcp.lastError}</span></Row> : null}
            <Row label="AI model"><StatusDot tone={claudeTone(claude)} label={claudeLabel(claude)} /></Row>
            {claude?.model ? <Row label="Model"><span className="font-mono text-[12px]">{claude.model}</span></Row> : null}
            {claude && !claude.configured ? <Row label="Configuration"><span className="text-bad">{claude.configError}</span></Row> : null}
          </dl>
          <p className="text-soft mt-2 text-[12px]">{mcp?.configured ? `Last attempt ${relativeTime(mcp?.lastAttempt)}. ` : "An MCP server is only needed for lab simulators; production networks come from an inventory file, Ansible, NetBox or discovery. "}<Link className="underline" href="/settings">Settings</Link></p>
        </section>

        <section aria-labelledby="lab">
          <h2 id="lab" className="label mb-1">Selected network</h2>
          {lab ? (
            <dl>
              <Row label="Name">{lab.title}</Row>
              <Row label="Source">{({ cml: "Cisco Modeling Labs", static: "Inventory file", ansible: "Ansible inventory", netbox: "NetBox", discovery: "Discovery" } as Record<string, string>)[lab.providerKind ?? "cml"]}</Row>
              <Row label="Environment"><span className={lab.environment === "production" ? "font-medium text-warn" : ""}>{lab.environment ?? "lab"}</span></Row>
              <Row label="State"><span className="font-mono text-[12px]">{lab.state}</span></Row>
              <Row label="Devices">{lab.nodeCount ?? "-"}</Row>
              <Row label="Links">{lab.linkCount ?? "-"}</Row>
            </dl>
          ) : settings?.selectedLabTitle ? (
            <p className="text-soft text-[13px]">"{settings.selectedLabTitle}" was selected earlier{mcp?.status === "connected" ? ", but is no longer listed" : ", and will be checked once its source is reachable"}. <Link className="underline" href="/networks">Choose a network</Link></p>
          ) : (
            <p className="text-soft text-[13px]">No network selected. <Link className="underline" href="/networks">Choose one</Link> to work on.</p>
          )}
        </section>
      </div>
    </>
  );
}
