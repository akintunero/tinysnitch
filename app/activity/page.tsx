"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";
import { apiGet, apiSend } from "@/lib/client";
import type { AuditEvent } from "@/lib/database/repo";
import { cn } from "@/lib/utils";

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

export default function Activity() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("all");
  const [reads, setReads] = useState(false);
  const { can } = useApp();
  const [hidden, setHidden] = useState(0);
  // Whoever audits every read ticks the box once; the choice is remembered in this browser.
  useEffect(() => {
    try { if (localStorage.getItem("ts.activity.reads") === "1") setReads(true); } catch { /* ignore */ }
  }, []);
  const chooseReads = (v: boolean) => {
    setReads(v);
    try { localStorage.setItem("ts.activity.reads", v ? "1" : "0"); } catch { /* ignore */ }
  };

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ events: AuditEvent[]; hiddenReads: number }>(`/api/activity?reads=${reads ? 1 : 0}`);
      setEvents(r.events);
      setHidden(r.hiddenReads);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [reads]);
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const kinds = [...new Set((events ?? []).map((e) => e.kind))].sort();
  // Page loads and polling read from the network sources all day; the server leaves those out unless asked.
  const shown = (events ?? []).filter((e) => kind === "all" || e.kind === kind);

  return (
    <>
      <PageHeader title="Activity">
        <label className="flex items-center gap-2 text-[12px]">
          <span className="text-soft">Show</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-7 rounded-sm border border-line bg-bg px-2 text-[12px]">
            <option value="all">All events</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12px]">
          <input type="checkbox" className="accent-accent" checked={reads} onChange={(e) => chooseReads(e.target.checked)} />
          <span className="text-soft">Background reads</span>
        </label>
        <Button onClick={() => void load()}>Refresh</Button>
      </PageHeader>
      {error ? <p role="alert" className="text-[13px] text-bad">{error}</p> : null}
      {can("admin") ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="label mr-1">Trim</span>
          <ConfirmButton
            size="sm"
            label="Clear background reads"
            confirmLabel="Yes, clear"
            message="Deletes the page-load and polling reads from the log. Everything else stays. This trim is recorded."
            onConfirm={() => apiSend("DELETE", "/api/activity?mode=reads")}
            onDone={() => void load()}
          />
          <ConfirmButton
            size="sm"
            label="Clear older than 90 days"
            confirmLabel="Yes, clear"
            message="Deletes every entry older than 90 days, including approvals and changes. This trim is recorded and cannot be undone."
            onConfirm={() => apiSend("DELETE", "/api/activity?mode=older&days=90")}
            onDone={() => void load()}
          />
        </div>
      ) : null}
      {!reads && hidden > 0 ? (
        <p className="text-soft mb-3 text-[12px]">
          {hidden.toLocaleString()} background reads (page loads and polling) are not shown.{" "}
          <button type="button" className="underline" onClick={() => chooseReads(true)}>Show them</button>
        </p>
      ) : null}
      {events && !shown.length ? <EmptyState title="No activity yet">Connection events, tool calls, setting changes, approvals and deployments appear here.</EmptyState> : null}
      {shown.length ? (
        <ol className="rounded-md border border-line bg-surface">
          {shown.map((e) => (
            <li key={e.id} className="flex flex-col gap-0.5 border-b border-line px-3 py-2 last:border-0 sm:flex-row sm:items-baseline sm:gap-3">
              <time dateTime={e.at} className="w-36 shrink-0 font-mono text-[11px] text-muted">{TIME.format(new Date(e.at))}</time>
              <span className={cn("w-24 shrink-0 text-[12px] font-medium", e.kind === "error" ? "text-bad" : "text-soft")}>{e.kind}</span>
              <span className="min-w-0 flex-1 break-words text-[13px]">{e.summary}</span>
              <span className="text-soft text-[12px]">{e.actor}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}
