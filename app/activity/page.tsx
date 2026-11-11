"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/status-dot";
import { apiGet } from "@/lib/client";
import type { AuditEvent } from "@/lib/database/repo";
import { cn } from "@/lib/utils";

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

export default function Activity() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("all");

  const load = useCallback(async () => {
    try {
      setEvents((await apiGet<{ events: AuditEvent[] }>("/api/activity")).events);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const kinds = [...new Set((events ?? []).map((e) => e.kind))].sort();
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
        <Button onClick={() => void load()}>Refresh</Button>
      </PageHeader>
      {error ? <p role="alert" className="text-[13px] text-bad">{error}</p> : null}
      {events && !shown.length ? <EmptyState title="No activity yet">Connection events, tool calls, settings changes and, later, approvals and deployments are recorded here. Credentials are never stored.</EmptyState> : null}
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
