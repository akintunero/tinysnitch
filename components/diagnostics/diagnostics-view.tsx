"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/assistant/markdown";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/status-dot";
import { ClientError, apiGet, apiSend } from "@/lib/client";
import type { DerivedLink, NodeFault } from "@/lib/diagnostics/state";
import type { StoredFinding, StoredRun } from "@/lib/diagnostics/store";
import { cn, relativeTime } from "@/lib/utils";

export type DiagnosticsData = {
  run: StoredRun | null; findings: StoredFinding[]; links: Record<string, DerivedLink>; nodeFaults: Record<string, NodeFault>; topologyError: string | null;
};

const SEV_TEXT = { critical: "text-bad", warning: "text-warn", info: "text-soft" } as const;

/** A prompt for the assistant built from a finding, evidence included, trimmed to fit. */
export function askAboutFinding(f: StoredFinding): string {
  const where = `${f.device}${f.interface ? ` ${f.interface}` : ""}`;
  return `Explain this ${f.status} finding and tell me what to check next: "${f.title}" on ${where}. ${f.description}\n\nEvidence:\n${f.evidence.slice(0, 6).map((e) => `- ${e}`).join("\n")}`.slice(0, 3500);
}

export function DiagnosticsView({ labId, labTitle }: { labId: string; labTitle: string | null }) {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [pings, setPings] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<DiagnosticsData>(`/api/labs/${labId}/diagnostics`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [labId]);

  useEffect(() => {
    setData(null);
    setSelected(null);
    setLoading(true);
    void load();
  }, [labId, load]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await apiSend<DiagnosticsData>("POST", `/api/labs/${labId}/diagnostics`, { pings });
      setData(r);
      setSelected(null);
    } catch (e) {
      setError(e instanceof ClientError && e.status === 409 ? "Diagnostics are already running for this lab." : (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const explain = async () => {
    setExplaining(true);
    setError(null);
    try {
      const r = await apiSend<{ text: string }>("POST", `/api/labs/${labId}/diagnostics/interpret`);
      setData((d) => (d?.run ? { ...d, run: { ...d.run, interpretation: r.text } } : d));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExplaining(false);
    }
  };

  const findings = data?.findings ?? [];
  const counts = useMemo(() => ({
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
    suspected: findings.filter((f) => f.status === "suspected").length,
  }), [findings]);
  const open = findings.find((f) => f.id === selected) ?? null;
  const run_ = data?.run ?? null;
  const skipped = run_?.devices.filter((d) => !d.inspected) ?? [];
  const inspected = run_?.devices.filter((d) => d.inspected).length ?? 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Diagnostics</h1>
          <p className="text-soft text-[12px]">{labTitle ?? "Selected lab"} · read-only checks on running routers and switches</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px]"><input type="checkbox" className="accent-ink" checked={pings} onChange={(e) => setPings(e.target.checked)} />Include ping tests</label>
          <Button variant="primary" onClick={() => void run()} disabled={running}>{running ? "Running" : run_ ? "Run again" : "Run diagnostics"}</Button>
        </div>
      </div>

      {error ? <p role="alert" className="mb-3 text-[13px] text-bad">{error}</p> : null}
      {loading ? <p className="text-soft">Loading...</p> : null}
      {running ? <p className="text-soft mb-3 text-[13px]">Reading devices through CML. This usually takes a few seconds per device.</p> : null}

      {!loading && !run_ ? (
        <EmptyState title="No diagnostics run yet">Run diagnostics to read interface, routing and switching state from the devices that are running. Nothing is changed on any device.</EmptyState>
      ) : null}

      {run_ ? (
        <>
          <p className="mb-1 text-[13px]">
            Last run {relativeTime(run_.finishedAt)}. {inspected} of {run_.devices.length} devices inspected.{" "}
            {inspected === 0
              ? "Nothing could be checked."
              : findings.length
              ? <>{counts.critical ? <span className="text-bad">{counts.critical} critical</span> : null}{counts.critical && (counts.warning || counts.info) ? ", " : ""}{counts.warning ? <span className="text-warn">{counts.warning} warning</span> : null}{counts.warning && counts.info ? ", " : ""}{counts.info ? `${counts.info} info` : null}. {counts.suspected ? `${counts.suspected} suspected, the rest confirmed from device output.` : "All confirmed from device output."}</>
              : "No findings."}
          </p>
          {data?.topologyError ? <p className="text-soft text-[12px]">Link colours could not be refreshed: {data.topologyError}</p> : null}

          {skipped.length ? (
            <details className="mt-2 text-[13px]"><summary className="cursor-pointer text-soft">Devices not inspected ({skipped.length})</summary>
              <ul className="mt-1 space-y-0.5">{skipped.map((d) => <li key={d.nodeId}><span className="font-medium">{d.label}</span> <span className="text-soft">{d.reason}</span></li>)}</ul>
            </details>
          ) : null}
          <details className="mt-1 text-[13px]"><summary className="cursor-pointer text-soft">What diagnostics does not check yet</summary>
            <ul className="mt-1 list-disc pl-5 text-soft">{run_.notRun.map((n) => <li key={n}>{n}</li>)}</ul>
          </details>

          <div className="mt-5 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section aria-label="Findings">
              {findings.length ? (
                <ul className="divide-y divide-line rounded-md border border-line bg-surface">
                  {findings.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => setSelected(f.id === selected ? null : f.id)} aria-pressed={f.id === selected}
                        className={cn("block w-full px-3 py-2 text-left hover:bg-surface-2", f.id === selected && "bg-surface-2")}>
                        <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide">
                          <span className={SEV_TEXT[f.severity]}>{f.severity}</span>
                          <span className={f.status === "confirmed" ? "text-ink" : "text-soft"}>{f.status}</span>
                        </div>
                        <div className="text-[13px] font-medium">{f.title}</div>
                        <div className="text-soft text-[12px]">{f.device}{f.interface ? ` · ${f.interface}` : ""}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : inspected === 0
                ? <EmptyState title="Nothing was checked">No device in this lab could be read, so there are no findings. This says nothing about the network's health. Start the routers and switches in CML, then run diagnostics again. The reasons are listed above.</EmptyState>
                : <EmptyState title="No findings">The checks saw nothing wrong on the devices they could read. That is not proof the network is healthy; see what is not checked above.</EmptyState>}
            </section>

            <section aria-label="Finding details">
              {open ? <FindingDetail f={open} /> : findings.length ? <p className="text-soft text-[13px]">Select a finding to see its evidence.</p> : null}
            </section>
          </div>

          <section className="mt-8 border-t border-line pt-4" aria-label="Explanation">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold">Explanation</h2>
              <Button onClick={() => void explain()} disabled={explaining}>{explaining ? "Asking Claude" : run_.interpretation ? "Explain again" : "Explain findings"}</Button>
            </div>
            <p className="text-soft mb-2 text-[12px]">Claude explains the findings above and suggests next checks. It cannot add findings, and nothing it suggests is applied.</p>
            {run_.interpretation ? <div className="text-[14px]"><Markdown>{run_.interpretation}</Markdown></div> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function FindingDetail({ f }: { f: StoredFinding }) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="mt-3"><h3 className="text-soft mb-0.5 text-[11px] font-semibold uppercase tracking-wide">{label}</h3><div className="text-[13px]">{children}</div></div>
  );
  return (
    <div className="rounded-md border border-ink bg-surface p-4">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span className={SEV_TEXT[f.severity]}>{f.severity}</span><span>{f.status}</span>
      </div>
      <h2 className="text-[15px] font-semibold">{f.title}</h2>
      <p className="text-soft text-[12px]">{f.device}{f.interface ? ` · ${f.interface}` : ""}{f.peer ? ` · to ${f.peer.device} ${f.peer.interface}` : ""}</p>
      <p className="mt-2 text-[13px]">{f.description}</p>
      <Row label="Evidence"><pre className="overflow-x-auto rounded-sm bg-ink p-2.5 font-mono text-[11.5px] leading-relaxed text-surface-2">{f.evidence.join("\n")}</pre></Row>
      <Row label="Probable cause">{f.probableCause}</Row>
      <Row label="Recommended action">{f.recommendedAction}</Row>
      <Row label={f.status === "confirmed" ? "How it was confirmed" : "How to confirm it"}>{f.verification}</Row>
      <p className="text-soft mt-3 text-[11px]">First seen {relativeTime(f.firstSeen)}, last seen {relativeTime(f.lastSeen)}.</p>
      <div className="mt-3 flex flex-wrap gap-3 text-[13px]">
        <Link className="underline decoration-line underline-offset-2 hover:decoration-ink" href={`/topology?finding=${encodeURIComponent(f.id)}`}>Show on topology</Link>
        <Link className="underline decoration-line underline-offset-2 hover:decoration-ink" href={`/assistant?q=${encodeURIComponent(askAboutFinding(f))}`}>Ask the assistant about this</Link>
      </div>
    </div>
  );
}
