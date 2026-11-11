"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/status-dot";
import type { Change, ChangeStatus } from "@/lib/changes/store";
import { apiGet, apiSend } from "@/lib/client";
import { cn, relativeTime } from "@/lib/utils";

const STATUS: Record<ChangeStatus, { label: string; tone: string }> = {
  proposed: { label: "Proposed", tone: "text-warn" }, approved: { label: "Approved", tone: "text-ink" }, deploying: { label: "Applying", tone: "text-warn" },
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
  const { settings, labs } = useApp();
  const scopeId = settings?.selectedLabId ?? null;
  const scope = labs.labs.find((l) => l.id === scopeId);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [mode, setMode] = useState<string>(settings?.executionMode ?? "approve");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [ztp, setZtp] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!scopeId) return;
    try {
      const r = await apiGet<{ changes: Change[]; mode: string }>(`/api/changes?scope=${encodeURIComponent(scopeId)}`);
      setChanges(r.changes);
      setMode(r.mode);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scopeId]);

  useEffect(() => { setChanges(null); setOpenId(null); void load(); }, [load]);

  // While a change is being applied or rolled back, check on it every couple of seconds.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (changes?.some((c) => BUSY.has(c.status))) timer.current = setTimeout(() => void load(), 2000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [changes, load]);

  const act = async (c: Change, action: "approve" | "reject" | "deploy" | "rollback" | "save") => {
    setBusy(`${c.id}:${action}`);
    setError(null);
    try {
      await apiSend("POST", `/api/changes/${c.id}/${action}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!scopeId) return <EmptyState title="Select a network first">Choose a network on the Networks page, then propose, review and apply changes to it here.</EmptyState>;
  const open = changes?.find((c) => c.id === openId) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Configurations</h1>
          <p className="text-soft text-[12px]">{scope?.title ?? "Selected network"} · {scope?.environment ?? "lab"} · mode: {mode === "approve" ? "Approve and deploy" : mode === "suggest" ? "Suggest" : "Autopilot"}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { setZtp((v) => !v); setCreating(false); }}>{ztp ? "Close provisioning" : "Provision new devices"}</Button>
          <Button variant="primary" onClick={() => { setCreating((v) => !v); setZtp(false); }}>{creating ? "Close" : "New change"}</Button>
        </div>
      </div>

      {mode === "suggest" ? <p className="mb-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-[13px]">Suggest mode: changes can be drafted and reviewed, but not approved or applied. Switch to Approve and deploy in Settings to apply them.</p> : null}
      {scope?.environment === "production" ? <p className="mb-3 rounded-sm border border-warn px-3 py-2 text-[13px]">This is a production network. Every change needs your approval, a snapshot is taken first, and Autopilot never applies changes here.</p> : null}
      {error ? <p role="alert" className="mb-3 text-[13px] text-bad">{error}</p> : null}

      {creating ? <NewChange scopeId={scopeId} onDone={async (id) => { setCreating(false); await load(); setOpenId(id); }} /> : null}
      {ztp ? <Provisioning scopeId={scopeId} onDone={async (id) => { setZtp(false); await load(); setOpenId(id); }} /> : null}

      {changes === null ? <p className="text-soft">Loading...</p> : changes.length === 0 && !creating && !ztp ? (
        <EmptyState title="No changes yet" action={<Link className="underline underline-offset-2" href={`/assistant?q=${encodeURIComponent("Propose a change: ")}`}>Ask the assistant to draft one</Link>}>
          Write a change, ask the assistant to propose one, or provision new devices. Nothing is applied until you approve it.
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <ul className="divide-y divide-line self-start rounded-md border border-line bg-surface" aria-label="Changes">
            {changes?.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpenId(c.id === openId ? null : c.id)} aria-pressed={c.id === openId} className={cn("block w-full px-3 py-2 text-left hover:bg-surface-2", c.id === openId && "bg-surface-2")}>
                  <div className={cn("text-[11px] font-semibold uppercase tracking-wide", STATUS[c.status].tone)}>{STATUS[c.status].label}</div>
                  <div className="truncate text-[13px] font-medium">{c.title}</div>
                  <div className="text-soft text-[12px]">{c.plan.devices.map((d) => d.label).join(", ")} · {relativeTime(c.createdAt)}</div>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="Change details">{open ? <Detail c={open} mode={mode} busy={busy} act={act} networkTitle={scope?.title ?? ""} /> : <p className="text-soft text-[13px]">Select a change to review it.</p>}</section>
        </div>
      )}
    </div>
  );
}

function Detail({ c, mode, busy, act, networkTitle }: { c: Change; mode: string; busy: string | null; act: (c: Change, a: "approve" | "reject" | "deploy" | "rollback" | "save") => Promise<void>; networkTitle: string }) {
  const [confirm, setConfirm] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const suggest = mode === "suggest";
  const working = BUSY.has(c.status);
  const lines = c.plan.devices.reduce((n, d) => n + d.commands.length, 0);
  const high = c.plan.devices.flatMap((d) => d.risks.filter((r) => r.risk === "high").map((r) => ({ d: d.label, ...r })));
  const needsReview = c.environment === "production" || high.length > 0;
  const b = (a: string) => busy === `${c.id}:${a}`;

  return (
    <div className="rounded-md border border-ink bg-surface p-4">
      <div className={cn("text-[11px] font-semibold uppercase tracking-wide", STATUS[c.status].tone)}>{STATUS[c.status].label}{working ? " ..." : ""}</div>
      <h2 className="text-[15px] font-semibold">{c.title}</h2>
      <p className="text-soft text-[12px]">{SOURCE[c.source]} · {c.environment} · {lines} line(s) on {c.plan.devices.length} device(s) · {relativeTime(c.createdAt)}{c.approvedAt ? ` · approved by ${c.approvedBy} ${relativeTime(c.approvedAt)}` : ""}</p>
      {c.intent ? <p className="mt-2 text-[13px]">{c.intent}</p> : null}
      {c.plan.warnings.length ? <ul className="mt-2 space-y-0.5 text-[12px] text-warn">{c.plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}

      {c.plan.devices.map((d) => (
        <div key={d.deviceId} className="mt-3">
          <h3 className="text-soft mb-0.5 text-[11px] font-semibold uppercase tracking-wide">{d.label} · {d.platform}</h3>
          <pre className="overflow-x-auto rounded-sm bg-ink p-2.5 font-mono text-[11.5px] leading-relaxed text-surface-2">{d.commands.map((cmd, i) => `${d.risks[i]?.risk === "high" ? "! " : "  "}${cmd}`).join("\n")}</pre>
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
        {c.status === "proposed" ? <>
          <Button variant="primary" disabled={suggest || busy !== null} onClick={() => void act(c, "approve")}>{b("approve") ? "Approving" : "Approve"}</Button>
          <Button disabled={busy !== null} onClick={() => void act(c, "reject")}>Reject</Button>
        </> : null}
        {c.status === "approved" ? (confirm ? (
          <div className="w-full space-y-2">
            {needsReview ? <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1 accent-ink" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I have read every line above and want it applied to {networkTitle}{c.environment === "production" ? " (production)" : ""}.</label> : null}
            <div className="flex gap-2">
              <Button variant="primary" disabled={suggest || busy !== null || (needsReview && !reviewed)} onClick={() => void act(c, "deploy")}>{b("deploy") ? "Starting" : "Apply now"}</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            </div>
          </div>
        ) : <Button variant="primary" disabled={suggest || busy !== null} onClick={() => setConfirm(true)}>Apply...</Button>) : null}
        {c.status === "approved" && !confirm ? <Button disabled={busy !== null} onClick={() => void act(c, "reject")}>Reject</Button> : null}
        {(c.status === "verified" || c.status === "failed" || c.status === "rollback_failed") && c.snapshot ? <Button disabled={suggest || busy !== null} onClick={() => void act(c, "rollback")}>{b("rollback") ? "Starting" : c.status === "rollback_failed" ? "Retry rollback" : "Roll back"}</Button> : null}
        {c.status === "verified" && !c.result?.saved ? <Button disabled={busy !== null} onClick={() => void act(c, "save")}>{b("save") ? "Saving" : "Save to startup"}</Button> : null}
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
