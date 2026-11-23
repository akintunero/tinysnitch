"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ServicePanel, LinesView } from "@/components/changes/service-panel";
import { useApp } from "@/components/layout/status-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/status-dot";
import { apiGet, apiSend } from "@/lib/client";
import type { Field } from "@/lib/provisioning/catalog";
import type { HistoryEntry, ServiceInstance, ServiceStatus } from "@/lib/provisioning/instances";
import type { ServiceExposure } from "@/lib/provisioning/impact";
import type { DeviceLines } from "@/lib/provisioning/lifecycle";
import { cn, relativeTime } from "@/lib/utils";

type Detail = ServiceInstance & { history: HistoryEntry[] };
type CatalogEntry = { id: string; title: string; fields: Field[] };

const TONE: Record<ServiceStatus, string> = { pending: "text-warn", active: "text-ok", failed: "text-bad", inactive: "text-soft", retired: "text-soft" };
const EXPLAIN: Record<ServiceStatus, string> = {
  pending: "A change is open for this service. A person approves and applies it on the Configurations page; the service becomes active once it is verified on the devices.",
  active: "In place: the last change was verified on the devices.",
  failed: "The last change did not verify, so the devices may be partly configured. Retry it, take it away, or stop tracking it.",
  inactive: "This was never applied to the devices. Retry it, or stop tracking it.",
  retired: "Taken away from the devices.",
};
const OP: Record<string, string> = { provision: "Provision", modify: "Change", decommission: "Remove" };

export function ServicesView() {
  const { settings, labs, can } = useApp();
  const scopeId = settings?.selectedLabId ?? null;
  const network = labs.labs.find((l) => l.id === scopeId);
  const [services, setServices] = useState<ServiceInstance[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [exposure, setExposure] = useState<ServiceExposure[]>([]);
  const [retired, setRetired] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ServiceInstance | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [plan, setPlan] = useState<{ kind: "decommission" | "retry"; lines: DeviceLines[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ changeId: string; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!scopeId) return;
    try {
      setServices((await apiGet<{ services: ServiceInstance[] }>(`/api/services?scope=${encodeURIComponent(scopeId)}${retired ? "&retired=1" : ""}`)).services);
      // What the latest diagnostics run says about the devices these services are on. A failure here must not hide the services.
      apiGet<{ services: ServiceExposure[] }>(`/api/services/impact?scope=${encodeURIComponent(scopeId)}`).then((r) => setExposure(r.services)).catch(() => setExposure([]));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [scopeId, retired]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await apiGet<Detail>(`/api/services/${id}`)); } catch (e) { setError((e as Error).message); setDetail(null); }
  }, []);

  useEffect(() => { setServices(null); setOpenId(null); setDetail(null); void load(); }, [load]);
  useEffect(() => { apiGet<{ services: CatalogEntry[] }>("/api/provisioning").then((r) => setCatalog(r.services)).catch(() => undefined); }, []);
  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);
  // A service follows its change, so while one is open the page keeps asking, and it catches up when you come back to the tab.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") { void load(); if (openId) void loadDetail(openId); } };
    const timer = (services ?? []).some((s) => s.status === "pending") ? setInterval(again, 5000) : null;
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { if (timer) clearInterval(timer); window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [services, openId, load, loadDetail]);

  if (!scopeId) return <EmptyState title="Select a network first">Choose a network on the Networks page, then provision and manage its services here.</EmptyState>;

  const refresh = async (id?: string) => { await load(); if (id ?? openId) await loadDetail((id ?? openId)!); };
  const filed = async (changeId: string | null) => {
    setCreating(false); setEditing(null); setPlan(null);
    setNotice(changeId ? { changeId, text: "Filed. It becomes a change a person approves and applies." } : { changeId: "", text: "Renamed." });
    await load();
  };

  const showPlan = async (kind: "decommission" | "retry") => {
    if (!detail) return;
    setBusy(kind); setError(null); setPlan(null);
    try {
      const r = await apiSend<{ plan: { devices: DeviceLines[] } }>("POST", `/api/services/${detail.id}/${kind}`, { dryRun: true });
      setPlan({ kind, lines: r.plan.devices });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const fileFromPlan = async () => {
    if (!detail || !plan) return;
    setBusy("file"); setError(null);
    try {
      const r = await apiSend<{ change: { id: string } }>("POST", `/api/services/${detail.id}/${plan.kind}`, {});
      setPlan(null);
      setNotice({ changeId: r.change.id, text: plan.kind === "decommission" ? "Removal filed. It becomes a change a person approves and applies." : "Retry filed. It becomes a change a person approves and applies." });
      await refresh(detail.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const risksOf = (id: string) => exposure.find((e) => e.serviceId === id)?.risks ?? [];
  const seriousOf = (id: string) => risksOf(id).filter((r) => r.severity !== "info");
  const fieldLabel = (serviceId: string, key: string) => catalog.find((c) => c.id === serviceId)?.fields.find((f) => f.id === key)?.label ?? key;
  const canAct = can("operator");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight">Services</h1>
          <p className="text-soft text-[12px]">{network?.title ?? "Selected network"} · what has been provisioned, whether it is really in place, and how to change or remove it</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-soft flex items-center gap-1.5 text-[12px]"><input type="checkbox" className="accent-accent" checked={retired} onChange={(e) => setRetired(e.target.checked)} />Show retired</label>
          <Button variant="primary" disabled={!canAct} onClick={() => { setCreating((v) => !v); setEditing(null); }}>{creating ? "Close" : "New service"}</Button>
        </div>
      </div>

      {notice ? (
        <p role="status" className="mb-3 rounded-sm border border-line bg-surface-2 px-3 py-2 text-[13px]">
          {notice.text} {notice.changeId ? <Link className="underline" href={`/configurations?change=${notice.changeId}`}>Review it on Configurations</Link> : null}
          <button type="button" className="text-soft ml-3 text-[12px] underline" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      ) : null}
      {error ? <p role="alert" className="mb-3 text-[13px] text-bad">{error}</p> : null}

      {creating ? <ServicePanel scopeId={scopeId} onDone={filed} onCancel={() => setCreating(false)} /> : null}
      {editing ? <ServicePanel scopeId={scopeId} existing={editing} onDone={filed} onCancel={() => setEditing(null)} /> : null}

      {services === null ? <p className="text-soft">Loading...</p> : services.length === 0 && !creating ? (
        <EmptyState title="No services yet" action={canAct ? <Button onClick={() => setCreating(true)}>New service</Button> : undefined}>
          A service is something you provision from a form, such as a VLAN, a routed interface or a BGP neighbour. Tiny Snitch remembers it, shows whether it is in place, and lets you change or remove it later through approved changes.
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <ul className="divide-y divide-line self-start rounded-md border border-line bg-surface" aria-label="Services">
            {services.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => { setOpenId(s.id === openId ? null : s.id); setPlan(null); }} aria-pressed={s.id === openId} className={cn("block w-full px-3 py-2 text-left hover:bg-surface-2", s.id === openId && "bg-surface-2")}>
                  <div className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-medium">{s.name}</span><span className="flex items-center gap-1">{seriousOf(s.id).length ? <Badge className={seriousOf(s.id).some((r) => r.severity === "critical") ? "text-bad" : "text-warn"}>at risk</Badge> : null}<Badge className={TONE[s.status]}>{s.status}</Badge></span></div>
                  <div className="text-soft truncate text-[12px]">{s.title} · <span className="font-mono">{s.devices.join(", ")}</span> · {relativeTime(s.updatedAt)}</div>
                </button>
              </li>
            ))}
          </ul>

          <section aria-label="Service details">
            {!detail ? <p className="text-soft text-[13px]">Select a service to see what it is, where it is and its history.</p> : (
              <div className="rounded-md border border-ink bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2"><Badge className={TONE[detail.status]}>{detail.status}</Badge><h2 className="text-[15px] font-semibold">{detail.name}</h2></div>
                <p className="text-soft text-[12px]">{detail.title} · provisioned {relativeTime(detail.createdAt)}{detail.createdBy ? ` by ${detail.createdBy}` : ""}</p>
                <p className="mt-2 text-[13px]">{EXPLAIN[detail.status]}{detail.pending ? <> <Link className="underline" href={`/configurations?change=${detail.pending.changeId}`}>Open the change</Link></> : null}</p>

                <h3 className="label mb-1 mt-4">What it is</h3>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[13px]">
                  {Object.entries(detail.values).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-soft">{fieldLabel(detail.serviceId, k)}</dt><dd className="font-mono text-[12px]">{String(v)}</dd></div>
                  ))}
                  <div className="contents"><dt className="text-soft">Devices</dt><dd className="font-mono text-[12px]">{detail.devices.join(", ")}</dd></div>
                </dl>
                {detail.applied && JSON.stringify(detail.applied.values) !== JSON.stringify(detail.values) ? <p className="text-soft mt-1 text-[12px]">A change is open that would alter what is on the devices now.</p> : null}

                {risksOf(detail.id).length ? (
                  <>
                    <h3 className="label mb-1 mt-4">Affected by</h3>
                    <ul className="space-y-1 text-[13px]">
                      {risksOf(detail.id).map((r) => (
                        <li key={r.findingId} className="flex flex-wrap items-center gap-2">
                          <Badge className={r.severity === "critical" ? "text-bad" : r.severity === "warning" ? "text-warn" : "text-soft"}>{r.severity}</Badge>
                          <span>{r.title}</span>
                          <span className="text-soft text-[12px]">{r.match === "interface" ? "on an interface it uses" : "on a device it is on"}{r.status === "suspected" ? " · suspected" : ""}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-[12px]"><Link className="underline" href="/diagnostics">Open Diagnostics</Link></p>
                  </>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {canAct && detail.status === "active" ? <Button disabled={busy !== null} onClick={() => { setEditing(detail); setCreating(false); setPlan(null); }}>Change...</Button> : null}
                  {canAct && (detail.status === "failed" || detail.status === "inactive") ? <Button disabled={busy !== null} onClick={() => void showPlan("retry")}>{busy === "retry" ? "Working" : "Retry..."}</Button> : null}
                  {canAct && (detail.status === "active" || detail.status === "failed") ? (detail.removable
                    ? <Button disabled={busy !== null} onClick={() => void showPlan("decommission")}>{busy === "decommission" ? "Working" : "Take away..."}</Button>
                    : <span className="text-soft max-w-sm text-[12px]" title={detail.notRemovable ?? undefined}>Cannot be taken away automatically. {detail.notRemovable}</span>) : null}
                  {can("approver") && !detail.pending ? (
                    <ConfirmButton size="sm" variant="ghost" label="Stop tracking" confirmLabel="Yes, stop tracking" message="Forgets this service. Nothing is sent to any device: whatever is configured there stays configured. Recorded in Activity."
                      onConfirm={() => apiSend("DELETE", `/api/services/${detail.id}`)} onDone={() => { setOpenId(null); void load(); }} />
                  ) : null}
                </div>

                {plan ? (
                  <div className="mt-4 border-t border-line pt-3">
                    <p className="label mb-2">{plan.kind === "decommission" ? "What would be removed" : "What would be sent"}</p>
                    <LinesView lines={plan.lines} />
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" disabled={busy !== null} onClick={() => void fileFromPlan()}>{busy === "file" ? "Filing" : plan.kind === "decommission" ? "File the removal" : "File the retry"}</Button>
                      <Button variant="ghost" onClick={() => setPlan(null)}>Cancel</Button>
                    </div>
                    <p className="text-soft mt-1 text-[11px]">It becomes a change that a person approves and applies, with a snapshot and rollback like any other.</p>
                  </div>
                ) : null}

                <h3 className="label mb-1 mt-4">History</h3>
                <ul className="space-y-1 text-[13px]">
                  {detail.history.map((h) => (
                    <li key={`${h.changeId}-${h.createdAt}`} className="flex flex-wrap items-center gap-2">
                      <span className="w-20">{OP[h.op] ?? h.op}</span>
                      {h.changeStatus ? <Badge className={h.changeStatus === "verified" ? "text-ok" : h.changeStatus === "failed" || h.changeStatus === "rollback_failed" ? "text-bad" : "text-soft"}>{h.changeStatus.replace("_", " ")}</Badge> : <Badge className="text-soft">removed</Badge>}
                      <span className="text-soft text-[12px]">{relativeTime(h.createdAt)}</span>
                      {h.title ? <Link className="text-[12px] underline" href={`/configurations?change=${h.changeId}`}>{h.title}</Link> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
