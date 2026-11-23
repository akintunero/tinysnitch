"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ServicePanel } from "./service-panel";
import { EmptyState } from "@/components/ui/status-dot";
import type { ChangePreview } from "@/lib/changes/preview";
import type { Change, ChangeStatus } from "@/lib/changes/store";
import { apiGet, apiSend } from "@/lib/client";
import { cn, relativeTime } from "@/lib/utils";

const DELETABLE = new Set(["proposed", "rejected", "rolled_back", "verified", "failed", "rollback_failed"]);
const STATUS: Record<ChangeStatus, { label: string; tone: string }> = {
  proposed: { label: "Proposed", tone: "text-warn" }, approved: { label: "Approved", tone: "text-ink" }, deploying: { label: "Applying", tone: "text-warn" }, paused: { label: "Paused after canary", tone: "text-warn" },
  verified: { label: "Applied and verified", tone: "text-ok" }, failed: { label: "Failed", tone: "text-bad" }, rolling_back: { label: "Rolling back", tone: "text-warn" },
  rolled_back: { label: "Rolled back", tone: "text-soft" }, rollback_failed: { label: "Rollback incomplete", tone: "text-bad" }, rejected: { label: "Rejected", tone: "text-soft" },
};
const SOURCE = { user: "Written by you", assistant: "Proposed by the assistant", ztp: "Provisioning" } as const;
const BUSY = new Set<ChangeStatus>(["deploying", "rolling_back"]);

type Candidate = { device: string; unconfigured: boolean; reason: string };

const ZTP_EXAMPLE = (devices: string[]) => JSON.stringify({
  devices: (devices.length ? devices : ["R1"]).map((d, i) => ({
    device: d, hostname: `${d.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    interfaces: [{ name: "GigabitEthernet0/0", address: `10.0.${i}.1/30`, description: "to core", ospfArea: 0 }],
    ospf: { processId: 1, routerId: `1.1.1.${i + 1}`, passive: [] },
  })),
}, null, 2);

export function ChangesView() {
  const { settings, labs, can } = useApp();
  const scopeId = settings?.selectedLabId ?? null;
  const scope = labs.labs.find((l) => l.id === scopeId);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [mode, setMode] = useState<string>(settings?.executionMode ?? "approve");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [ztp, setZtp] = useState(false);
  const [servicing, setServicing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLinked = useRef(false);

  const load = useCallback(async () => {
    if (!scopeId) return;
    try {
      const r = await apiGet<{ changes: Change[]; mode: string }>(`/api/changes?scope=${encodeURIComponent(scopeId)}`);
      setChanges(r.changes);
      // A link from the Services page (?change=<id>) opens that change once the list has loaded.
      const wanted = new URLSearchParams(window.location.search).get("change");
      if (wanted && !deepLinked.current && r.changes.some((c) => c.id === wanted)) { deepLinked.current = true; setOpenId(wanted); }
      // A change that was selected and has since gone, or started running, is no longer a choice.
      setPicked((p) => p.filter((id) => r.changes.some((c) => c.id === id && DELETABLE.has(c.status))));
      setMode(r.mode);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scopeId]);

  useEffect(() => { setChanges(null); setOpenId(null); void load(); }, [load]);
  // Come back to a tab that has gone stale (a change removed or finished elsewhere) and it catches up at once.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [load]);

  // While a change is being applied or rolled back, check on it every couple of seconds.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (changes?.some((c) => BUSY.has(c.status))) timer.current = setTimeout(() => void load(), 2000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [changes, load]);

  const act = async (c: Change, action: "approve" | "reject" | "deploy" | "rollback" | "save" | "continue" | "schedule", body?: unknown) => {
    setBusy(`${c.id}:${action}`);
    setError(null);
    try {
      await apiSend("POST", `/api/changes/${c.id}/${action}`, body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!scopeId) return <EmptyState title="Select a network first">Choose a network on the Networks page, then propose, review and apply changes to it here.</EmptyState>;
  const open = changes?.find((c) => c.id === openId) ?? null;
  const removable = (changes ?? []).filter((c) => DELETABLE.has(c.status));
  const finished = (changes ?? []).filter((c) => ["verified", "rolled_back", "rejected"].includes(c.status)).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight">Configurations</h1>
          <p className="text-soft text-[12px]">{scope?.title ?? "Selected network"} · {scope?.environment ?? "lab"} · mode: {mode === "approve" ? "Approve and deploy" : mode === "suggest" ? "Suggest" : "Autopilot"}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {can("approver") && finished > 0 ? (
            <ConfirmButton
              label={`Clear finished (${finished})`}
              confirmLabel="Yes, clear"
              message={`Removes the ${finished} verified, rolled back and rejected change${finished === 1 ? "" : "s"} of this network from the list. Proposed, failed and in-progress ones stay. Recorded in Activity.`}
              onConfirm={() => apiSend("POST", "/api/changes/clear", { scopeId })}
              onDone={() => { setOpenId(null); void load(); }}
            />
          ) : null}
          <Button disabled={!can("operator")} onClick={() => { setZtp((v) => !v); setCreating(false); setServicing(false); }}>{ztp ? "Close provisioning" : "Provision new devices"}</Button>
          <Button disabled={!can("operator")} onClick={() => { setServicing((v) => !v); setCreating(false); setZtp(false); }}>{servicing ? "Close service" : "New service"}</Button>
          <Button variant="primary" disabled={!can("operator")} onClick={() => { setCreating((v) => !v); setZtp(false); setServicing(false); }}>{creating ? "Close" : "New change"}</Button>
        </div>
      </div>

      {mode === "suggest" ? <p className="mb-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-[13px]">Suggest mode: changes can be drafted and reviewed, but not approved or applied. Switch to Approve and deploy in Settings to apply them.</p> : null}
      {scope?.environment === "production" ? <p className="mb-3 rounded-sm border border-warn px-3 py-2 text-[13px]">This is a production network. Every change needs your approval, a snapshot is taken first, and Autopilot never applies changes here.</p> : null}
      {error ? <p role="alert" className="mb-3 text-[13px] text-bad">{error}</p> : null}

      {creating ? <NewChange scopeId={scopeId} onDone={async (id) => { setCreating(false); await load(); setOpenId(id); }} /> : null}
      {ztp ? <Provisioning scopeId={scopeId} onDone={async (id) => { setZtp(false); await load(); setOpenId(id); }} /> : null}
      {servicing ? <ServicePanel scopeId={scopeId} onDone={async (id) => { setServicing(false); await load(); if (id) setOpenId(id); }} onCancel={() => setServicing(false)} /> : null}

      {changes === null ? <p className="text-soft">Loading...</p> : changes.length === 0 && !creating && !ztp && !servicing ? (
        <EmptyState title="No changes yet" action={<Link className="underline underline-offset-2" href={`/assistant?q=${encodeURIComponent("Propose a change: ")}`}>Ask the assistant to draft one</Link>}>
          Write a change, provision a service from a form, ask the assistant to propose one, or provision new devices. Nothing is applied until you approve it.
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="self-start">
            {can("approver") && removable.length > 0 ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-accent" checked={picked.length > 0 && picked.length === removable.length} onChange={(e) => setPicked(e.target.checked ? removable.map((c) => c.id) : [])} />
                  <span className="text-soft">Select all</span>
                </label>
                {picked.length > 0 ? (
                  <ConfirmButton
                    size="sm"
                    label={`Remove selected (${picked.length})`}
                    confirmLabel="Yes, remove"
                    message={`Removes ${picked.length} change${picked.length === 1 ? "" : "s"} from the list. A failed or half-undone one loses its snapshot too. Anything still in flight is skipped. Recorded in Activity.`}
                    onConfirm={async () => {
                      const r = await apiSend<{ removed: number; skipped: { title: string; reason: string }[] }>("POST", "/api/changes/remove", { ids: picked });
                      // One that is already gone (removed from another tab, say) is not a failure: it is what was asked for.
                      const blocked = r.skipped.filter((x) => x.reason !== "No such change.");
                      if (blocked.length) {
                        void load();
                        throw new Error(`${r.removed} removed. Not removed: ${blocked.map((x) => `${x.title} (${x.reason})`).join("; ")}`);
                      }
                    }}
                    onDone={() => { setPicked([]); setOpenId(null); void load(); }}
                  />
                ) : null}
              </div>
            ) : null}
            <ul className="divide-y divide-line rounded-md border border-line bg-surface" aria-label="Changes">
              {changes?.map((c) => (
                <li key={c.id} className="flex items-stretch">
                  {can("approver") && DELETABLE.has(c.status) ? (
                    <label className="flex items-center pl-3" title="Select to remove">
                      <span className="sr-only">Select {c.title}</span>
                      <input type="checkbox" className="accent-accent" checked={picked.includes(c.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, c.id] : x.filter((i) => i !== c.id)))} />
                    </label>
                  ) : null}
                  <button type="button" onClick={() => setOpenId(c.id === openId ? null : c.id)} aria-pressed={c.id === openId} className={cn("block min-w-0 flex-1 px-3 py-2 text-left hover:bg-surface-2", c.id === openId && "bg-surface-2")}>
                    <Badge className={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    <div className="truncate text-[13px] font-medium">{c.title}</div>
                    <div className="text-soft text-[12px]">{c.plan.devices.map((d) => d.label).join(", ")} · {relativeTime(c.createdAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <section aria-label="Change details">{open ? <Detail c={open} mode={mode} busy={busy} act={act} networkTitle={scope?.title ?? ""} onDeleted={async () => { setOpenId(null); await load(); }} /> : <p className="text-soft text-[13px]">Select a change to review it.</p>}</section>
        </div>
      )}
    </div>
  );
}

function Detail({ c, mode, busy, act, networkTitle, onDeleted }: { c: Change; mode: string; busy: string | null; act: (c: Change, a: "approve" | "reject" | "deploy" | "rollback" | "save" | "continue" | "schedule", body?: unknown) => Promise<void>; networkTitle: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [reason, setReason] = useState("");
  const [at, setAt] = useState("");
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const runPreview = async () => {
    setPreviewing(true); setPreviewError(null);
    try { setPreview(await apiGet<ChangePreview>(`/api/changes/${c.id}/preview`)); } catch (e) { setPreviewError((e as Error).message); } finally { setPreviewing(false); }
  };
  const ro = c.plan.rollout?.mode === "staged" && c.plan.devices.length > 1 ? c.plan.rollout : null;
  const { can, session } = useApp();
  const suggest = mode === "suggest" || !can("approver"); // a role below approver can look but not decide
  const working = BUSY.has(c.status);
  const lines = c.plan.devices.reduce((n, d) => n + d.commands.length, 0);
  const high = c.plan.devices.flatMap((d) => d.risks.filter((r) => r.risk === "high").map((r) => ({ d: d.label, ...r })));
  const needsReview = c.environment === "production" || high.length > 0;
  const b = (a: string) => busy === `${c.id}:${a}`;

  return (
    <div className="rounded-md border border-accent/60 bg-surface p-4">
      <Badge className={STATUS[c.status].tone}>{STATUS[c.status].label}{working ? " ..." : ""}</Badge>
      <h2 className="text-[15px] font-semibold">{c.title}</h2>
      <p className="text-soft text-[12px]">{SOURCE[c.source]} · {c.environment} · {lines} line(s) on {c.plan.devices.length} device(s) · {relativeTime(c.createdAt)}{c.approvedAt ? ` · approved by ${c.approvedBy} ${relativeTime(c.approvedAt)}` : ""}</p>
      {c.intent ? <p className="mt-2 text-[13px]">{c.intent}</p> : null}
      {c.plan.warnings.length ? <ul className="mt-2 space-y-0.5 text-[12px] text-warn">{c.plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {ro ? <p className="mt-2 text-[12px]">Staged rollout: {c.plan.devices.slice(0, ro.canary).map((d) => d.label).join(", ")} first{ro.pauseAfterCanary ? ", then it pauses for you to check and continue" : ", then the rest"}.</p> : null}
      {c.scheduledFor ? <p className="mt-1 text-[12px]">Scheduled for {new Date(c.scheduledFor).toLocaleString()}.</p> : null}
      {["proposed", "approved", "paused"].includes(c.status) ? (
        <div className="mt-3">
          <Button size="sm" onClick={() => void runPreview()} disabled={previewing}>{previewing ? "Reading devices" : preview ? "Preview again" : "Preview against the devices"}</Button>
          <span className="text-soft ml-2 text-[12px]">Reads each device now and changes nothing.</span>
          {previewError ? <p role="alert" className="mt-1 text-[12px] text-bad">{previewError}</p> : null}
          {preview ? (
            <div className="mt-2 rounded-sm border border-line p-2.5 text-[12px]">
              <p className="font-medium">{preview.summary}</p>
              {preview.devices.map((d) => (
                <div key={d.label} className="mt-2">
                  <div className="font-medium">{d.label}{preview.canary.includes(d.label) ? " (canary)" : ""}</div>
                  {!d.reachable ? <p className="text-bad">Could not be read: {d.error}</p> : (
                    <ul className="list-disc pl-5">
                      <li>{d.wouldChange.length ? `${d.wouldChange.length} line(s) would change it` : "Already has every line; applying it would change nothing"}{d.alreadyInPlace.length && d.wouldChange.length ? `, ${d.alreadyInPlace.length} already in place` : ""}</li>
                      {d.cutoff ? <li className="text-bad">Would lose contact: {d.cutoff}</li> : null}
                      {d.deviceCheck ? <li className={d.deviceCheck.ok ? "text-ok" : "text-bad"}>{d.deviceCheck.text}</li> : null}
                      {d.highRisk.map((h) => <li key={h} className="text-warn">High risk: {h}</li>)}
                    </ul>
                  )}
                </div>
              ))}
              <p className="text-soft mt-2">Read {new Date(preview.at).toLocaleTimeString()}. Devices can change before the change is applied.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {c.plan.devices.map((d) => (
        <div key={d.deviceId} className="mt-3">
          <h3 className="text-soft mb-0.5 text-[11px] font-semibold uppercase tracking-wide">{d.label} · {d.platform}</h3>
          <pre className="overflow-x-auto rounded-sm bg-code p-2.5 font-mono text-[11.5px] leading-relaxed text-code-ink">{d.commands.map((cmd, i) => `${d.risks[i]?.risk === "high" ? "! " : "  "}${cmd}`).join("\n")}</pre>
        </div>
      ))}
      {high.length ? <p className="text-soft mt-1 text-[11px]">Lines marked ! are high risk: {high.map((h) => `${h.d}: ${h.reason}`).filter((v, i, a) => a.indexOf(v) === i).join("; ")}.</p> : null}

      {c.result ? (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-soft mb-1 text-[11px] font-semibold uppercase tracking-wide">What happened</h3>
          <p className="text-[13px]">{c.result.summary}</p>
          {c.result.regressions.length ? <ul className="mt-1 list-disc pl-5 text-[12px] text-warn">{c.result.regressions.map((r) => <li key={r.id}>New {r.severity} finding on {r.device}: {r.title}</li>)}</ul> : null}
          {c.result.devices.map((d) => (
            <div key={d.label} className="mt-2">
              <div className="text-[12px] font-medium">{d.label}</div>
              <ul className="text-soft list-disc pl-5 text-[12px]">{d.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              {d.mismatches.length ? <ul className="list-disc pl-5 text-[12px] text-bad">{d.mismatches.map((m) => <li key={m.command}>{m.command}: expected {m.expected}</li>)}</ul> : null}
            </div>
          ))}
          <p className="text-soft mt-2 text-[11px]">{c.result.saved ? "Saved to the startup configuration." : c.status === "verified" ? "Running configuration only; not saved to startup." : ""}</p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {!can("approver") && ["proposed", "approved", "paused", "verified", "failed"].includes(c.status) ? <p className="text-soft w-full text-[12px]">Your role ({session?.user?.role}) can review this change but not approve or apply it.</p> : null}
        {c.status === "proposed" ? <>
          <Button variant="primary" disabled={suggest || busy !== null} onClick={() => void act(c, "approve")}>{b("approve") ? "Approving" : "Approve"}</Button>
          <Button disabled={busy !== null} onClick={() => void act(c, "reject")}>Reject</Button>
        </> : null}
        {c.status === "approved" ? (confirm ? (
          <div className="w-full space-y-2">
            {needsReview ? <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1 accent-accent" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I have read every line above and want it applied to {networkTitle}{c.environment === "production" ? " (production)" : ""}.</label> : null}
            <div className="flex gap-2">
              <Button variant="primary" disabled={suggest || busy !== null || (needsReview && !reviewed)} onClick={() => void act(c, "deploy", reason.trim() ? { overrideReason: reason.trim() } : undefined)}>{b("deploy") ? "Starting" : "Apply now"}</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            </div>
          </div>
        ) : <Button variant="primary" disabled={suggest || busy !== null} onClick={() => setConfirm(true)}>Apply...</Button>) : null}
        {c.status === "approved" && !confirm ? <Button disabled={busy !== null} onClick={() => void act(c, "reject")}>Reject</Button> : null}
        {c.status === "approved" ? (
          <div className="flex w-full flex-wrap items-center gap-2 text-[12px]">
            <label>Schedule <input type="datetime-local" className="ml-1 h-7 rounded-sm border border-line bg-bg px-1.5" value={at} onChange={(e) => setAt(e.target.value)} /></label>
            <Button size="sm" disabled={suggest || busy !== null || !at} onClick={() => void act(c, "schedule", { at: new Date(at).toISOString() })}>{b("schedule") ? "Saving" : "Set time"}</Button>
            {c.scheduledFor ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(c, "schedule", { at: null })}>Cancel schedule</Button> : null}
            <label className="ml-auto">Reason, if applying outside the maintenance window <input className="ml-1 h-7 w-56 rounded-sm border border-line bg-bg px-1.5" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="only for an emergency" /></label>
          </div>
        ) : null}
        {c.status === "paused" ? (
          <>
            <Button variant="primary" disabled={suggest || busy !== null} onClick={() => void act(c, "continue", reason.trim() ? { overrideReason: reason.trim() } : undefined)}>{b("continue") ? "Starting" : `Continue to the other ${c.plan.devices.length - (ro?.canary ?? 1)} device(s)`}</Button>
            <label className="text-[12px]">Reason, if outside the maintenance window <input className="ml-1 h-7 w-56 rounded-sm border border-line bg-bg px-1.5" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
          </>
        ) : null}
        {(c.status === "verified" || c.status === "failed" || c.status === "rollback_failed" || c.status === "paused") && c.snapshot ? <Button disabled={suggest || busy !== null} onClick={() => void act(c, "rollback")}>{b("rollback") ? "Starting" : c.status === "rollback_failed" ? "Retry rollback" : "Roll back"}</Button> : null}
        {c.status === "verified" && !c.result?.saved ? <Button disabled={busy !== null} onClick={() => void act(c, "save")}>{b("save") ? "Saving" : "Save to startup"}</Button> : null}
        {can("approver") && DELETABLE.has(c.status) ? (
          <ConfirmButton
            size="sm"
            variant="ghost"
            label="Delete"
            message={c.status === "failed" || c.status === "rollback_failed"
              ? "This also deletes the snapshot taken before the change, which rollback uses, and the device may not match what was intended. Recorded in Activity."
              : "Removes this change from the list. Recorded in Activity."}
            onConfirm={() => apiSend("DELETE", `/api/changes/${c.id}`)}
            onDone={onDeleted}
          />
        ) : null}
        <a className="text-soft ml-auto text-[12px] underline decoration-line underline-offset-2 hover:decoration-ink" href={`/api/changes/${c.id}/playbook`} download title="Running it through Ansible skips Tiny Snitch's snapshot, verification and rollback">Download as Ansible playbook</a>
        {working ? <span className="text-soft text-[12px]">Working on the devices. This page updates by itself.</span> : null}
      </div>
    </div>
  );
}

function NewChange({ scopeId, onDone }: { scopeId: string; onDone: (id: string) => Promise<void> }) {
  const [devices, setDevices] = useState<string[]>([]);
  const [rows, setRows] = useState<{ device: string; commands: string }[]>([{ device: "", commands: "" }]);
  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");
  const [staged, setStaged] = useState<boolean | null>(null); // null: let the server decide (production with several devices is staged)
  const [canary, setCanary] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<{ nodes: { label: string; kind: string }[] }>(`/api/labs/${encodeURIComponent(scopeId)}/topology`).then((t) => setDevices(t.nodes.filter((n) => ["router", "l2switch", "l3switch"].includes(n.kind)).map((n) => n.label))).catch((e) => setError((e as Error).message));
  }, [scopeId]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = await apiSend<Change>("POST", "/api/changes", {
        scopeId, title: title || "Untitled change", intent,
        devices: rows.filter((r) => r.device && r.commands.trim()).map((r) => ({ device: r.device, commands: r.commands.split(/\r?\n/) })),
        ...(staged === null ? {} : { rollout: staged ? { mode: "staged", canary, pauseAfterCanary: true } : { mode: "all", canary: 1, pauseAfterCanary: false } }),
      });
      await onDone(c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6 rounded-md border border-line bg-surface p-4">
      <h2 className="mb-2 text-[14px] font-semibold">New change</h2>
      <p className="text-soft mb-3 text-[12px]">Write the configuration lines for each device without <span className="font-mono">configure terminal</span> or <span className="font-mono">end</span>. Saving only files a proposal; nothing is sent to a device. Lines that erase, reload or copy files are refused.</p>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block text-[12px]">Title<input className="mt-0.5 block h-8 w-full rounded-sm border border-line bg-bg px-2 text-[13px]" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Bring up the London to Paris link" /></label>
        <label className="block text-[12px]">What it is for<input className="mt-0.5 block h-8 w-full rounded-sm border border-line bg-bg px-2 text-[13px]" value={intent} maxLength={2000} onChange={(e) => setIntent(e.target.value)} /></label>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="mt-3 grid gap-2 md:grid-cols-[14rem_minmax(0,1fr)]">
          <label className="block text-[12px]">Device
            <select className="mt-0.5 block h-8 w-full rounded-sm border border-line bg-bg px-2 text-[13px]" value={r.device} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, device: e.target.value } : x)))}>
              <option value="">Choose a device</option>{devices.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <label className="block text-[12px]">Configuration lines
            <textarea rows={5} spellCheck={false} className="mt-0.5 block w-full rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-[12px]" value={r.commands} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, commands: e.target.value } : x)))} placeholder={"interface GigabitEthernet0/1\ndescription uplink\nno shutdown"} />
          </label>
        </div>
      ))}
      {rows.filter((r) => r.device).length > 1 ? (
        <fieldset className="mt-3 text-[12px]">
          <legend className="font-medium">Rollout</legend>
          <label className="mr-4"><input type="radio" name="rollout" className="mr-1 accent-accent" checked={staged === null} onChange={() => setStaged(null)} />Default (staged for production, all at once for labs)</label>
          <label className="mr-4"><input type="radio" name="rollout" className="mr-1 accent-accent" checked={staged === true} onChange={() => setStaged(true)} />Staged: first <input type="number" min={1} max={19} className="mx-1 h-6 w-12 rounded-sm border border-line bg-bg px-1" value={canary} onChange={(e) => setCanary(Math.max(1, Number(e.target.value) || 1))} /> device(s), then pause</label>
          <label><input type="radio" name="rollout" className="mr-1 accent-accent" checked={staged === false} onChange={() => setStaged(false)} />All at once</label>
        </fieldset>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <Button onClick={() => setRows([...rows, { device: "", commands: "" }])} disabled={rows.length >= 20}>Add a device</Button>
        <Button variant="primary" disabled={saving} onClick={() => void submit()}>{saving ? "Checking" : "Check and file proposal"}</Button>
      </div>
    </div>
  );
}

function Provisioning({ scopeId, onDone }: { scopeId: string; onDone: (id: string) => Promise<void> }) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [plan, setPlan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiGet<{ candidates: Candidate[] }>(`/api/ztp?scope=${encodeURIComponent(scopeId)}`);
      setCands(r.candidates);
      if (!plan) setPlan(ZTP_EXAMPLE(r.candidates.filter((c) => c.unconfigured).map((c) => c.device)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(plan); } catch { throw new Error("The plan is not valid JSON."); }
      const c = await apiSend<Change>("POST", `/api/ztp?scope=${encodeURIComponent(scopeId)}`, { plan: parsed });
      await onDone(c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-md border border-line bg-surface p-4">
      <h2 className="mb-1 text-[14px] font-semibold">Provision new devices</h2>
      <p className="text-soft mb-3 text-[12px]">Describe the baseline each new device should get. Tiny Snitch finds devices that are up but still on a default hostname with no addresses, and files your plan as a normal change: reviewed, approved, snapshotted, verified and reversible.</p>
      <Button onClick={() => void find()} disabled={busy}>{busy && !cands ? "Reading devices" : "Find unconfigured devices"}</Button>
      {cands ? (
        <ul className="mt-3 space-y-0.5 text-[13px]">
          {cands.map((c) => <li key={c.device}><span className="font-medium">{c.device}</span> <span className={c.unconfigured ? "text-ok" : "text-soft"}>{c.unconfigured ? "unconfigured" : "skipped"}</span> <span className="text-soft">{c.reason}</span></li>)}
        </ul>
      ) : null}
      {cands ? (
        <>
          <label className="mt-3 block text-[12px]">Provisioning plan (JSON)
            <textarea rows={12} spellCheck={false} className="mt-0.5 block w-full rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-[12px]" value={plan} onChange={(e) => setPlan(e.target.value)} />
          </label>
          <p className="text-soft mt-1 text-[11px]">Addresses are written as address/prefix. Hostnames count as high-risk lines, so provisioning always waits for your approval.</p>
          <div className="mt-2"><Button variant="primary" disabled={busy || !plan.trim()} onClick={() => void propose()}>{busy ? "Checking" : "File proposal"}</Button></div>
        </>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p> : null}
    </div>
  );
}
