"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/status-dot";
import type { Diff } from "@/lib/backup/diff";
import type { Backup, BackupMeta, DriftEvent } from "@/lib/backup/store";
import { ClientError, apiGet, apiSend } from "@/lib/client";
import { cn, relativeTime } from "@/lib/utils";

type Overview = {
  scopeId: string; devices: { device: string; latest: BackupMeta; versions: number }[]; drift: DriftEvent[];
  monitored: boolean; backupIntervalMinutes: number; diagnosticsIntervalMinutes: number;
};
type Version = { backup: Backup; against: { id: number; takenAt: string; source: string } | null; diff: Diff | null; versions: BackupMeta[] };
type RunResult = { devices: { device: string; status: string; reason?: string }[]; drift: DriftEvent[] };

const INTERVALS = [{ v: 0, l: "Off" }, { v: 60, l: "Every hour" }, { v: 360, l: "Every 6 hours" }, { v: 1440, l: "Every day" }, { v: 10080, l: "Every week" }];
const SOURCE = (s: string) => (s === "scheduled" ? "Scheduled" : s === "manual" ? "Manual" : s.startsWith("pre-change:") ? "Before a change" : s.startsWith("change:") ? "After a change" : s.startsWith("rollback:") ? "After a rollback" : s);

export function BackupsView() {
  const { settings, labs, updateSettings, can } = useApp();
  const scopeId = settings?.selectedLabId ?? null;
  const scope = labs.labs.find((l) => l.id === scopeId);
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState<Version | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!scopeId) return;
    try {
      setData(await apiGet<Overview>(`/api/backups?scope=${encodeURIComponent(scopeId)}`));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [scopeId]);
  useEffect(() => { setData(null); setOpen(null); setNote(null); void load(); }, [load]);

  const view = async (id: number, against?: number) => {
    setError(null);
    try { setOpen(await apiGet<Version>(`/api/backups/${id}${against ? `?against=${against}` : ""}`)); } catch (e) { setError((e as Error).message); }
  };

  const runNow = async () => {
    setBusy("run"); setError(null); setNote(null);
    try {
      const r = await apiSend<RunResult>("POST", "/api/backups/run", { scopeId });
      const n = (s: string) => r.devices.filter((d) => d.status === s).length;
      setNote(`Read ${r.devices.length - n("skipped") - n("failed")} device(s): ${n("new") + n("changed")} new version(s), ${n("unchanged")} unchanged${n("failed") ? `, ${n("failed")} could not be read` : ""}${n("skipped") ? `, ${n("skipped")} skipped` : ""}. ${r.drift.length ? `${r.drift.length} drift event(s) found.` : "No drift."}`);
      await load();
    } catch (e) { setError(e instanceof ClientError && e.status === 409 ? `${(e as Error).message}` : (e as Error).message); } finally { setBusy(null); }
  };

  const ack = async (d: DriftEvent) => {
    setBusy(`ack${d.id}`);
    try { await apiSend("POST", `/api/drift/${d.id}/acknowledge`); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const toggleMonitor = async (on: boolean) => {
    if (!scopeId || !settings) return;
    const set = new Set(settings.monitoredScopes);
    if (on) set.add(scopeId); else set.delete(scopeId);
    try { await updateSettings({ monitoredScopes: [...set] }); await load(); } catch (e) { setError((e as Error).message); }
  };

  if (!scopeId) return <EmptyState title="Select a network first">Choose a network on the Networks page. Its configurations can then be backed up, compared and checked for changes nobody made through Tiny Snitch.</EmptyState>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Backups and drift</h1>
          <p className="text-soft text-[12px]">{scope?.title ?? "Selected network"} · {scope?.environment ?? "lab"} · reads configurations only; nothing is changed on any device</p>
        </div>
        <Button variant="primary" onClick={() => void runNow()} disabled={busy !== null || !can("operator")}>{busy === "run" ? "Reading devices" : "Back up now"}</Button>
      </div>
      {error ? <p role="alert" className="mb-3 text-[13px] text-bad">{error}</p> : null}
      {note ? <p role="status" className="mb-3 text-[13px]">{note}</p> : null}

      <section aria-label="Schedule" className="mb-5 rounded-md border border-line bg-surface p-3">
        <label className="flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-1 accent-accent" checked={data?.monitored ?? false} disabled={!data} onChange={(e) => void toggleMonitor(e.target.checked)} />
          <span><span className="font-medium">Back up and check this network on a schedule</span><span className="text-soft block text-[12px]">Read-only. A job is skipped while a change is being applied. The intervals below apply to every network you switch on.</span></span>
        </label>
        <div className="mt-2 flex flex-wrap gap-4 text-[12px]">
          <label>Backups <select className="ml-1 h-7 rounded-sm border border-line bg-bg px-2" value={settings?.backupIntervalMinutes ?? 0} onChange={(e) => void updateSettings({ backupIntervalMinutes: Number(e.target.value) })}>{INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.l}</option>)}</select></label>
          <label>Diagnostics <select className="ml-1 h-7 rounded-sm border border-line bg-bg px-2" value={settings?.diagnosticsIntervalMinutes ?? 0} onChange={(e) => void updateSettings({ diagnosticsIntervalMinutes: Number(e.target.value) })}>{INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.l}</option>)}</select></label>
        </div>
      </section>

      {data && data.drift.length ? (
        <section aria-label="Drift" className="mb-6">
          <h2 className="mb-1 text-[14px] font-semibold">Configuration changed outside Tiny Snitch ({data.drift.length})</h2>
          <ul className="divide-y divide-line rounded-md border border-warn bg-surface">
            {data.drift.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{d.device} <span className="text-soft font-normal">· {relativeTime(d.detectedAt)}</span></div>
                  <div className="text-[12px]"><span className="text-ok">+{d.linesAdded}</span> <span className="text-bad">-{d.linesRemoved}</span> lines · <span className="text-soft">{d.possibleChange ? `A change that failed or never finished touched this device (${d.possibleChange.slice(0, 8)}); this may be what is left of it.` : "No Tiny Snitch change explains this."}</span></div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void view(d.toBackup, d.fromBackup)}>View changes</Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => void ack(d)}>{busy === `ack${d.id}` ? "Saving" : "Acknowledge"}</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : data ? <p className="text-soft mb-5 text-[13px]">No unacknowledged drift. A difference is called drift only when no Tiny Snitch change explains it.</p> : null}

      {data === null ? <p className="text-soft">Loading...</p> : data.devices.length === 0 ? (
        <EmptyState title="Nothing backed up yet" action={<Button onClick={() => void runNow()} disabled={busy !== null}>Back up now</Button>}>Backups read each router's and switch's running configuration. A new version is stored only when it differs from the last one.</EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]">
          <ul className="divide-y divide-line self-start rounded-md border border-line bg-surface" aria-label="Devices">
            {data.devices.map((d) => (
              <li key={d.device}>
                <button type="button" onClick={() => void view(d.latest.id)} aria-pressed={open?.backup.device === d.device} className={cn("block w-full px-3 py-2 text-left hover:bg-surface-2", open?.backup.device === d.device && "bg-surface-2")}>
                  <div className="text-[13px] font-medium">{d.device}</div>
                  <div className="text-soft text-[12px]">{d.versions} version{d.versions === 1 ? "" : "s"} · latest {relativeTime(d.latest.takenAt)} · {SOURCE(d.latest.source)}</div>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="Version">
            {open ? (
              <div className="rounded-md border border-ink bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[14px] font-semibold">{open.backup.device}</h2>
                    <p className="text-soft text-[12px]">{relativeTime(open.backup.takenAt)} · {SOURCE(open.backup.source)} · {Math.round(open.backup.bytes / 100) / 10} KB</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {can("approver") && open.versions[0]?.id !== open.backup.id ? (
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        label="Delete version"
                        message="Removes this stored version and the drift records that point at it. The newest version is never deletable. Recorded in Activity."
                        onConfirm={() => apiSend("DELETE", `/api/backups/${open.backup.id}`)}
                        onDone={() => { const next = open.versions.find((v) => v.id !== open.backup.id); setOpen(null); void load(); if (next) void view(next.id); }}
                      />
                    ) : null}
                    <a className="text-[12px] underline decoration-line underline-offset-2 hover:decoration-ink" href={`/api/backups/${open.backup.id}/download`} download>Download</a>
                  </div>
                </div>
                <label className="mt-2 block text-[12px]">Version
                  <select className="ml-2 h-7 rounded-sm border border-line bg-bg px-2" value={open.backup.id} onChange={(e) => void view(Number(e.target.value))}>
                    {open.versions.map((v) => <option key={v.id} value={v.id}>{relativeTime(v.takenAt)} · {SOURCE(v.source)}</option>)}
                  </select>
                </label>
                <h3 className="text-soft mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide">{open.diff ? `Changes since ${relativeTime(open.against!.takenAt)} (${SOURCE(open.against!.source)}): +${open.diff.added} -${open.diff.removed}` : "First version stored"}</h3>
                {open.diff ? (open.diff.lines.length ? (
                  <pre className="max-h-[28rem] overflow-auto rounded-sm bg-code p-2.5 font-mono text-[11.5px] leading-relaxed text-code-ink">
                    {open.diff.lines.map((l, i) => <div key={i} className={l.op === "+" ? "text-[#8fd19e]" : l.op === "-" ? "text-[#f0a1a1]" : l.op === "~" ? "text-muted" : ""}>{l.op === "~" ? `  ... ${l.text} ...` : `${l.op} ${l.text}`}</div>)}
                    {open.diff.truncated ? <div className="text-muted">  ... the rest is not shown; download the file ...</div> : null}
                  </pre>
                ) : <p className="text-soft text-[13px]">No differences after ignoring timestamps and other lines a device rewrites by itself.</p>) : (
                  <pre className="max-h-[28rem] overflow-auto rounded-sm bg-code p-2.5 font-mono text-[11.5px] leading-relaxed text-code-ink">{open.backup.config}</pre>
                )}
              </div>
            ) : <p className="text-soft text-[13px]">Select a device to see its versions and what changed.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
