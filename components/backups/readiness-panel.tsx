"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/client";
import type { DeviceReadiness } from "@/lib/readiness";

type Readiness = { scopeId: string; environment: "lab" | "production"; required: boolean; baselineMaxDays: number; devices: DeviceReadiness[] };

/** Which devices may be changed on a production network, why the others may not, and where a person signs one off. */
export function ReadinessPanel({ scopeId, reloadKey }: { scopeId: string; reloadKey: unknown }) {
  const { can } = useApp();
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiGet<Readiness>(`/api/readiness?scope=${encodeURIComponent(scopeId)}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [scopeId]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  const act = async (device: string, action: "signoff" | "revoke") => {
    setBusy(device);
    try { await apiSend("POST", "/api/readiness", { scopeId, device, action }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (error) return <p role="alert" className="mb-5 text-[13px] text-bad">{error}</p>;
  if (!data) return null;
  const ready = data.devices.filter((d) => d.ready).length;
  const open = data.required && ready < data.devices.length;
  return (
    <details open={open} className="mb-5 rounded-md border border-line bg-surface" data-testid="readiness">
      <summary className="cursor-pointer px-3 py-2 text-[13px]">
        <span className="font-medium">Ready to go live</span>
        <span className="text-soft"> · {ready} of {data.devices.length} device{data.devices.length === 1 ? "" : "s"}{data.required ? "" : data.environment === "lab" ? " · not required on a lab network" : " · switched off in Settings"}</span>
      </summary>
      <div className="border-t border-line px-3 py-2">
        <p className="text-soft mb-2 text-[12px]">{data.required ? "A change to a production network is refused, when it is proposed and again when it is applied, if a device it touches fails a check below." : "Nothing is refused on this network, but the checks still show where each device stands."} A backup counts for {data.baselineMaxDays} days.</p>
        <ul className="divide-y divide-line">
          {data.devices.map((d) => {
            const wrong = d.checks.filter((c) => !c.ok);
            const canSign = wrong.every((c) => c.id === "signoff");
            return (
              <li key={d.device} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{d.device} <span className={d.ready ? "text-ok font-normal" : "text-warn font-normal"}>{d.ready ? "Ready" : "Not ready"}</span></div>
                  {d.ready
                    ? <div className="text-soft text-[12px]">Signed off by {d.signedOff?.by} {d.signedOff ? d.signedOff.at.slice(0, 10) : ""}.</div>
                    : <ul className="text-soft mt-0.5 space-y-0.5 text-[12px]">{wrong.map((c) => <li key={c.id}><span className="text-ink">{c.label}.</span> {c.detail}</li>)}</ul>}
                </div>
                {can("approver") ? (
                  d.signedOff
                    ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(d.device, "revoke")}>Withdraw sign-off</Button>
                    : <Button size="sm" disabled={busy !== null || !canSign} title={canSign ? undefined : "Fix the other checks first"} onClick={() => void act(d.device, "signoff")}>{busy === d.device ? "Saving" : "Sign off as ready"}</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
