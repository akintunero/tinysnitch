"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/client";
import type { Field, ServiceDef, Values } from "@/lib/provisioning/catalog";
import type { DeviceLines } from "@/lib/provisioning/lifecycle";
import type { ServiceInstance } from "@/lib/provisioning/instances";
import { cn } from "@/lib/utils";

type Service = Omit<ServiceDef, "render">;
type Node = { label: string; kind: string; platform?: string };
type Lines = DeviceLines[];

const GROUPS = ["Switching", "Routing", "Redundancy", "Security", "Management"] as const;
const inputCls = "mt-0.5 block h-8 w-full rounded-sm border border-line bg-bg px-2 text-[13px]";

function FieldInput({ f, value, onChange }: { f: Field; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  if (f.type === "boolean") {
    return (
      <label className="flex items-center gap-2 pt-5 text-[13px]">
        <input type="checkbox" className="accent-accent" checked={value === undefined ? f.default === true : value === true} onChange={(e) => onChange(e.target.checked)} />
        {f.label}
      </label>
    );
  }
  return (
    <label className="block text-[12px]">
      {f.label}{f.required ? <span className="text-bad"> *</span> : null}
      {f.type === "select" ? (
        <select className={inputCls} value={String(value ?? f.default ?? "")} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          className={cn(inputCls, ["ipv4", "cidr", "prefix", "interface", "interfaces", "vlans", "hostname", "domain", "name"].includes(f.type) && "font-mono")}
          inputMode={["vlan", "asn", "int"].includes(f.type) ? "numeric" : undefined}
          placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : undefined)}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {f.help ? <span className="text-soft mt-0.5 block text-[11px]">{f.help}</span> : null}
    </label>
  );
}

/** The lines each device would get. In a modification, what is taken away is shown apart from what is put in. */
export function LinesView({ lines }: { lines: Lines }) {
  return (
    <>
      {lines.map((d) => (
        <div key={d.device} className="mb-3">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-medium"><span className="font-mono">{d.device}</span><Badge className="text-soft">{d.platform}</Badge></div>
          {"commands" in d ? (
            <pre className="overflow-x-auto rounded-sm bg-code p-2.5 font-mono text-[11.5px] leading-relaxed text-code-ink">
              {d.commands.map((c, i) => <div key={i} className={i < d.remove ? "text-[#f0a1a1]" : ""}>{i < d.remove ? "- " : d.remove > 0 ? "+ " : ""}{c}</div>)}
            </pre>
          ) : <p className="text-[12px] text-bad">{d.error}</p>}
        </div>
      ))}
    </>
  );
}

/**
 * Provision a service from a form, or change one that exists. Pick the service, say what you want, choose the devices, and see
 * the exact lines each one would get. Filing it remembers the service and creates an ordinary change, so approval, the snapshot,
 * read-back verification and rollback all apply. Nothing here touches a device.
 */
export function ServicePanel({ scopeId, existing = null, onDone, onCancel }: { scopeId: string; existing?: ServiceInstance | null; onDone: (changeId: string | null) => Promise<void>; onCancel?: () => void }) {
  const modifying = existing !== null;
  const start = existing ? (existing.applied ?? { values: existing.values, devices: existing.devices }) : null;
  const [services, setServices] = useState<Service[] | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [serviceId, setServiceId] = useState<string | null>(existing?.serviceId ?? null);
  const [values, setValues] = useState<Values>((start?.values as Values) ?? {});
  const [chosen, setChosen] = useState<string[]>(start?.devices ?? []);
  const [name, setName] = useState(existing?.name ?? "");
  const [lines, setLines] = useState<Lines | null>(null);
  const [busy, setBusy] = useState<"preview" | "file" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ services: Service[] }>("/api/provisioning").then((r) => setServices(r.services)).catch((e) => setError((e as Error).message));
    apiGet<{ nodes: Node[] }>(`/api/labs/${encodeURIComponent(scopeId)}/topology`)
      .then((t) => setNodes(t.nodes.filter((n) => ["router", "l2switch", "l3switch"].includes(n.kind))))
      .catch((e) => setError((e as Error).message));
  }, [scopeId]);

  const service = services?.find((s) => s.id === serviceId) ?? null;
  const pick = (s: Service) => { setServiceId(s.id); setValues({}); setLines(null); setError(null); };
  const set = (id: string, v: string | number | boolean) => { setValues((x) => ({ ...x, [id]: v })); setLines(null); };
  const supported = (n: Node) => (service ? service.platforms.includes((n.platform ?? "ios") as never) : true);
  const usable = (lines ?? []).filter((d) => "commands" in d && d.commands.length > 0);

  const body = () => (modifying ? { name: name.trim() || undefined, values, devices: chosen } : { scopeId, serviceId: service?.id, name: name.trim(), values, devices: chosen });

  const preview = async () => {
    if (!service) return;
    setBusy("preview"); setError(null);
    try {
      if (modifying) {
        const r = await apiSend<{ plan: { devices: Lines } | null }>("PUT", `/api/services/${existing!.id}`, { ...body(), dryRun: true });
        setLines(r.plan?.devices ?? []);
      } else {
        const r = await apiSend<{ devices: { device: string; platform: string; commands?: string[]; error?: string }[] }>("POST", "/api/provisioning/render", { scopeId, service: service.id, values, devices: chosen });
        setLines(r.devices.map((d) => (d.commands ? { device: d.device, platform: d.platform as never, commands: d.commands, remove: 0, add: d.commands.length } : { device: d.device, platform: d.platform as never, error: d.error ?? "" })));
      }
    } catch (e) { setError((e as Error).message); setLines(null); } finally { setBusy(null); }
  };

  const file = async () => {
    setBusy("file"); setError(null);
    try {
      const r = modifying
        ? await apiSend<{ change: { id: string } | null }>("PUT", `/api/services/${existing!.id}`, body())
        : await apiSend<{ change: { id: string } }>("POST", "/api/services", body());
      await onDone(r.change?.id ?? null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const renameOnly = modifying && lines !== null && lines.length === 0;
  const canPreview = chosen.length > 0 && (modifying || name.trim().length >= 2);

  return (
    <div className="mb-6 rounded-md border border-line bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">{modifying ? `Change ${existing!.name}` : "New service"}</h2>
          <p className="text-soft max-w-prose text-[12px]">{modifying
            ? "Edit what the service is or where it is. You see exactly what would be removed and what would be put in before anything is filed; it still needs approval."
            : "Choose what to provision and fill in the details. The service is remembered, so it can be changed or taken away later. You see the exact lines for each device before anything is filed, and filing it creates a change that still needs approval."}</p>
        </div>
        {onCancel ? <Button size="sm" variant="ghost" onClick={onCancel}>Close</Button> : null}
      </div>
      <div className={cn("grid gap-0", !modifying && "md:grid-cols-[15rem_minmax(0,1fr)]")}>
        {!modifying ? (
          <nav aria-label="Services" className="border-b border-line p-3 md:border-b-0 md:border-r">
            {services === null ? <p className="text-soft text-[12px]">Loading...</p> : GROUPS.map((g) => (
              <div key={g} className="mb-3 last:mb-0">
                <p className="label mb-1">{g}</p>
                {services.filter((s) => s.group === g).map((s) => (
                  <button key={s.id} type="button" onClick={() => pick(s)} aria-pressed={s.id === serviceId} className={cn("block w-full border-l-2 px-2.5 py-1.5 text-left text-[13px]", s.id === serviceId ? "border-accent bg-surface-2 font-medium" : "border-transparent hover:bg-surface-2/60")}>{s.title}</button>
                ))}
              </div>
            ))}
          </nav>
        ) : null}

        <div className="p-4">
          {!service ? <p className="text-soft text-[13px]">Pick a service on the left.</p> : (
            <>
              <h3 className="text-[14px] font-semibold">{service.title}</h3>
              <p className="text-soft mb-3 text-[12px]">{service.summary}</p>
              <label className="mb-3 block max-w-md text-[12px]">Name for this service <span className="text-bad">*</span>
                <input className={inputCls} value={name} maxLength={80} placeholder={`for example, ${service.title} for guests`} onChange={(e) => { setName(e.target.value); }} />
                <span className="text-soft mt-0.5 block text-[11px]">{modifying ? "Renaming alone changes nothing on any device." : "How you will find it on the Services page."}</span>
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                {service.fields.map((f) => <FieldInput key={f.id} f={f} value={values[f.id]} onChange={(v) => set(f.id, v)} />)}
              </div>

              <fieldset className="mt-4">
                <legend className="label mb-1">Devices</legend>
                {nodes.length === 0 ? <p className="text-soft text-[12px]">No routers or switches were found in this network.</p> : (
                  <div className="grid gap-1 md:grid-cols-2">
                    {nodes.map((n) => {
                      const ok = supported(n);
                      return (
                        <label key={n.label} className={cn("flex items-center gap-2 text-[13px]", !ok && "opacity-50")} title={ok ? undefined : `${service.title} is not available for ${n.platform ?? "ios"} devices.`}>
                          <input type="checkbox" className="accent-accent" disabled={!ok} checked={chosen.includes(n.label)} onChange={(e) => { setChosen((c) => (e.target.checked ? [...c, n.label] : c.filter((x) => x !== n.label))); setLines(null); }} />
                          <span className="font-mono text-[12px]">{n.label}</span>
                          <Badge className="text-soft">{n.platform ?? "ios"}</Badge>
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-soft mt-1 text-[11px]">The same values go to every chosen device. For interface-specific services, pick one device at a time.</p>
              </fieldset>

              {error ? <p role="alert" className="mt-3 text-[13px] text-bad">{error}</p> : null}
              <div className="mt-4 flex gap-2">
                <Button variant={lines ? "secondary" : "primary"} disabled={busy !== null || !canPreview} onClick={() => void preview()}>{busy === "preview" ? "Working" : lines ? "Preview again" : "Preview configuration"}</Button>
              </div>

              {lines ? (
                <div className="mt-4 border-t border-line pt-3">
                  {renameOnly ? <p className="text-[13px]">Only the name changes. Nothing is sent to any device.</p> : <p className="label mb-2">{modifying ? "What would be removed and put in" : "What each device would get"}</p>}
                  <LinesView lines={lines} />
                  {renameOnly || usable.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <Button variant="primary" disabled={busy !== null} onClick={() => void file()}>{busy === "file" ? "Filing" : renameOnly ? "Rename" : modifying ? "File the change" : `Provision on ${usable.length} device${usable.length === 1 ? "" : "s"}`}</Button>
                      <span className="text-soft text-[12px]">{renameOnly ? "" : "It becomes a change that a person approves and applies."}</span>
                    </div>
                  ) : <p className="text-[12px] text-bad">None of the chosen devices can take this.</p>}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
