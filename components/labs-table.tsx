"use client";

import { useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/status-dot";
import { apiSend } from "@/lib/client";
import { cn } from "@/lib/utils";

const STATE_TONE: Record<string, string> = { STARTED: "text-ok", BOOTED: "text-ok", DISCOVERED: "text-ok", INVENTORY: "text-ok", STOPPED: "text-soft", DEFINED_ON_CORE: "text-soft", NOT_RUN: "text-soft" };
const SOURCE: Record<string, string> = { cml: "CML", static: "Inventory file", netbox: "NetBox", discovery: "Discovery" };

export function LabsTable() {
  const { status, settings, labs, refreshLabs, selectLab } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (labs.error && !labs.labs.length) {
    return (
      <EmptyState title="No network source is available" action={<Button onClick={() => void refreshLabs()}>Try again</Button>}>
        {labs.error}{status?.mcp.configured === false ? " Set up the CML MCP connection, or point TS_INVENTORY_FILE at an inventory file (see the README)." : ""}
      </EmptyState>
    );
  }
  if (!labs.labs.length) return <p className="text-soft">{labs.loading ? "Loading networks..." : "No networks were found."}</p>;

  const choose = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await selectLab(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const discover = async (id: string) => {
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      const r = await apiSend<{ devices: number; links: number; warnings: string[] }>("POST", `/api/discovery/${encodeURIComponent(id.replace(/^discovery:/, ""))}/run`);
      setNote(`Discovery found ${r.devices} devices and ${r.links} links.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`);
      await refreshLabs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {labs.totals ? <p className="text-soft mb-3 text-[13px]">{labs.totals.labs} networks, {labs.totals.nodes} devices, {labs.totals.links} links.</p> : null}
      {labs.warnings.length ? <ul className="mb-3 space-y-0.5 text-[12px] text-warn">{labs.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {error ? <p role="alert" className="mb-2 text-[13px] text-bad">{error}</p> : null}
      {note ? <p role="status" className="mb-2 text-[13px]">{note}</p> : null}
      <div className="overflow-x-auto rounded-md border border-line bg-surface">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-line text-[12px] text-soft">
            <tr><th className="px-3 py-2 font-medium">Network</th><th className="px-3 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Environment</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 text-right font-medium">Devices</th><th className="px-3 py-2 text-right font-medium">Links</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {labs.labs.map((l) => {
              const selected = settings?.selectedLabId === l.id;
              return (
                <tr key={l.id} className={cn("border-b border-line last:border-0", selected && "bg-surface-2")}>
                  {/* w-full + max-w-0 lets the title column shrink and truncate instead of forcing a scrollbar */}
                  <td className="w-full max-w-0 px-3 py-2"><div className="truncate font-medium">{l.title}</div>{l.description ? <div className="text-soft truncate text-[12px]">{l.description}</div> : null}</td>
                  <td className="text-soft whitespace-nowrap px-3 py-2 text-[12px]">{SOURCE[l.providerKind ?? "cml"]}</td>
                  <td className={cn("whitespace-nowrap px-3 py-2 text-[12px]", l.environment === "production" ? "font-semibold text-warn" : "text-soft")}>{l.environment ?? "lab"}</td>
                  <td className={cn("whitespace-nowrap px-3 py-2 font-mono text-[11px]", STATE_TONE[l.state] ?? "text-soft")}>{l.state}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.nodeCount ?? "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.linkCount ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {l.providerKind === "discovery" ? <Button size="sm" className="mr-2" disabled={busy !== null} onClick={() => void discover(l.id)}>{busy === l.id ? "Discovering" : l.state === "NOT_RUN" ? "Run discovery" : "Run again"}</Button> : null}
                    {selected ? <span className="text-[12px] font-medium">Selected</span> : <Button size="sm" disabled={busy !== null || l.state === "NOT_RUN"} onClick={() => void choose(l.id)}>Select</Button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
