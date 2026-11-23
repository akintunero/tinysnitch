"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { apiGet, apiSend } from "@/lib/client";
import type { ApiToken } from "@/lib/api/tokens";
import type { Delivery, Webhook } from "@/lib/api/webhooks";
import { ROLES, type Role } from "@/lib/auth/roles";
import { relativeTime } from "@/lib/utils";

const inputCls = "mt-0.5 block h-8 w-full rounded-sm border border-line bg-bg px-2 text-[13px]";

/** A secret that is shown once: copy it now, it cannot be read again. */
function ShownOnce({ title, value, children, onDone }: { title: string; value: string; children?: React.ReactNode; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="mb-4 rounded-sm border border-warn p-3">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="text-soft text-[12px]">Copy it now. It is not shown again, and only a fingerprint of it is kept here.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-code px-2 py-1.5 font-mono text-[12px] text-code-ink">{value}</code>
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? "Copied" : "Copy"}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>I have saved it</Button>
      </div>
      {children}
    </div>
  );
}

function tokenState(t: ApiToken): { label: string; tone: string } {
  if (t.revokedAt) return { label: "revoked", tone: "text-soft" };
  if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return { label: "expired", tone: "text-soft" };
  return { label: "active", tone: "text-ok" };
}

function Tokens() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [days, setDays] = useState("90");
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setTokens((await apiGet<{ tokens: ApiToken[] }>("/api/tokens")).tokens); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await apiSend<{ token: string }>("POST", "/api/tokens", { name, role, expiresInDays: days === "never" ? null : Number(days) });
      setMade(r.token); setName("");
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <h3 className="mb-1 text-[13px] font-semibold">Access tokens</h3>
      <p className="text-soft mb-3 max-w-prose text-[12px]">A token lets another system call the API with a role of its own. It can read, propose changes or approve them, but never manage users, tokens, webhooks or settings. Give each system its own token so one can be revoked alone.</p>
      {made ? (
        <ShownOnce title="Your new token" value={made} onDone={() => setMade(null)}>
          <p className="text-soft mt-2 text-[12px]">Use it as <code className="font-mono">Authorization: Bearer …</code>, for example <code className="break-all font-mono">curl -H &quot;Authorization: Bearer …&quot; {typeof window !== "undefined" ? window.location.origin : ""}/api/v1/networks</code></p>
        </ShownOnce>
      ) : null}
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="block min-w-48 flex-1 text-[12px]">Name<input className={inputCls} value={name} maxLength={80} placeholder="monitoring system" onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-[12px]">Role
          <select className={`${inputCls} w-32`} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        </label>
        <label className="block text-[12px]">Expires
          <select className={`${inputCls} w-32`} value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">in 30 days</option><option value="90">in 90 days</option><option value="365">in a year</option><option value="never">never</option>
          </select>
        </label>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>{busy ? "Creating" : "Create token"}</Button>
      </form>
      {error ? <p role="alert" className="mb-2 text-[13px] text-bad">{error}</p> : null}
      {tokens === null ? <p className="text-soft text-[13px]">Loading...</p> : tokens.length === 0 ? <p className="text-soft text-[13px]">No tokens yet.</p> : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead className="text-soft border-b border-line text-[12px]"><tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Role</th><th className="px-3 py-2 font-medium">Token</th><th className="px-3 py-2 font-medium">Last used</th><th className="px-3 py-2 font-medium">Expires</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {tokens.map((t) => {
                const st = tokenState(t);
                return (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2"><div className="font-medium">{t.name}</div><Badge className={st.tone}>{st.label}</Badge></td>
                    <td className="px-3 py-2">{t.role}</td>
                    <td className="px-3 py-2 font-mono text-[12px]">{t.prefix}…</td>
                    <td className="text-soft px-3 py-2 text-[12px]">{t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}</td>
                    <td className="text-soft px-3 py-2 text-[12px]">{t.expiresAt ? t.expiresAt.slice(0, 10) : "never"}</td>
                    <td className="px-3 py-2 text-right">
                      {st.label === "active" ? <ConfirmButton size="sm" variant="ghost" label="Revoke" confirmLabel="Yes, revoke" message={`Stops "${t.name}" working at once. Anything using it will get 401 errors.`} onConfirm={() => apiSend("DELETE", `/api/tokens/${t.id}`)} onDone={() => void load()} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type HookRow = Webhook & { lastDelivery: Delivery | null };

function deliveryTone(d: Delivery | null): { label: string; tone: string } {
  if (!d) return { label: "nothing sent", tone: "text-soft" };
  if (d.status === "delivered") return { label: "delivered", tone: "text-ok" };
  if (d.status === "failed") return { label: "failed", tone: "text-bad" };
  return { label: d.attempts ? "retrying" : "queued", tone: "text-warn" };
}

function Webhooks() {
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<string[]>(["*"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [log, setLog] = useState<Delivery[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ events: string[]; webhooks: HookRow[] }>("/api/webhooks");
      setHooks(r.webhooks); setEvents(r.events);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy("create"); setError(null);
    try {
      const r = await apiSend<{ secret: string }>("POST", "/api/webhooks", { name, url, events: chosen });
      setSecret(r.secret); setName(""); setUrl(""); setChosen(["*"]);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const test = async (h: HookRow) => {
    setBusy(h.id);
    try {
      const d = await apiSend<Delivery>("POST", `/api/webhooks/${h.id}/test`);
      setResult((r) => ({ ...r, [h.id]: d.status === "delivered" ? `The receiver accepted it (${d.lastStatus}).` : `Not accepted: ${d.lastError ?? "no answer"}` }));
      await load();
    } catch (e) { setResult((r) => ({ ...r, [h.id]: (e as Error).message })); } finally { setBusy(null); }
  };
  const toggle = async (h: HookRow) => { try { await apiSend("PUT", `/api/webhooks/${h.id}`, { enabled: !h.enabled }); await load(); } catch (e) { setError((e as Error).message); } };
  const showLog = async (h: HookRow) => {
    if (open === h.id) { setOpen(null); return; }
    setOpen(h.id);
    try { setLog((await apiGet<{ deliveries: Delivery[] }>(`/api/webhooks/${h.id}/deliveries`)).deliveries); } catch { setLog([]); }
  };
  const all = chosen.includes("*");
  const flip = (e: string) => setChosen((c) => (c.includes(e) ? c.filter((x) => x !== e) : [...c.filter((x) => x !== "*"), e]));

  return (
    <div>
      <h3 className="mb-1 text-[13px] font-semibold">Webhooks</h3>
      <p className="text-soft mb-3 max-w-prose text-[12px]">Tiny Snitch calls a URL when something happens, so another system does not have to keep asking. Each request is signed, and a receiver that is down gets it again later. Addresses on this machine, link-local addresses and cloud metadata addresses are always refused.</p>
      {secret ? <ShownOnce title="Signing secret" value={secret} onDone={() => setSecret(null)}><p className="text-soft mt-2 text-[12px]">The receiver checks <code className="font-mono">X-TinySnitch-Signature</code> with it. How is described in the API description.</p></ShownOnce> : null}
      <form className="mb-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
          <label className="block text-[12px]">Name<input className={inputCls} value={name} maxLength={80} placeholder="ticketing" onChange={(e) => setName(e.target.value)} /></label>
          <label className="block text-[12px]">URL<input className={`${inputCls} font-mono`} value={url} maxLength={500} placeholder="https://example.net/tiny-snitch" onChange={(e) => setUrl(e.target.value)} /></label>
        </div>
        <fieldset>
          <legend className="mb-1 text-[12px]">Events</legend>
          <label className="mr-4 inline-flex items-center gap-1.5 text-[12px]"><input type="checkbox" className="accent-accent" checked={all} onChange={(e) => setChosen(e.target.checked ? ["*"] : [])} />All events</label>
          {!all ? <div className="mt-1 grid gap-1 md:grid-cols-3">{events.filter((e) => e !== "webhook.test").map((e) => <label key={e} className="inline-flex items-center gap-1.5 font-mono text-[11.5px]"><input type="checkbox" className="accent-accent" checked={chosen.includes(e)} onChange={() => flip(e)} />{e}</label>)}</div> : null}
        </fieldset>
        <Button variant="primary" type="submit" disabled={busy !== null || !name.trim() || !url.trim() || chosen.length === 0}>{busy === "create" ? "Creating" : "Create webhook"}</Button>
      </form>
      {error ? <p role="alert" className="mb-2 text-[13px] text-bad">{error}</p> : null}
      {hooks === null ? <p className="text-soft text-[13px]">Loading...</p> : hooks.length === 0 ? <p className="text-soft text-[13px]">No webhooks yet.</p> : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {hooks.map((h) => {
            const st = deliveryTone(h.lastDelivery);
            return (
              <li key={h.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13px] font-medium">{h.name}{!h.enabled ? <Badge className="text-soft">disabled</Badge> : null}<Badge className={st.tone}>{st.label}</Badge></div>
                    <div className="text-soft truncate font-mono text-[12px]">{h.url}</div>
                    <div className="text-soft text-[12px]">{h.events.includes("*") ? "all events" : h.events.join(", ")}{h.lastDelivery ? ` · last ${relativeTime(h.lastDelivery.createdAt)}` : ""}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={busy !== null} onClick={() => void test(h)}>{busy === h.id ? "Sending" : "Send test"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(h)}>{h.enabled ? "Disable" : "Enable"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void showLog(h)}>{open === h.id ? "Hide log" : "Log"}</Button>
                    <ConfirmButton size="sm" variant="ghost" label="Delete" message={`Deletes "${h.name}" and its delivery log. Events not yet delivered are dropped.`} onConfirm={() => apiSend("DELETE", `/api/webhooks/${h.id}`)} onDone={() => void load()} />
                  </div>
                </div>
                {result[h.id] ? <p role="status" className="mt-1 text-[12px]">{result[h.id]}</p> : null}
                {open === h.id ? (
                  <ul className="mt-2 space-y-0.5 font-mono text-[11.5px]">
                    {log.length === 0 ? <li className="text-soft">Nothing sent yet.</li> : log.slice(0, 12).map((d) => <li key={d.id} className={d.status === "failed" ? "text-bad" : d.status === "delivered" ? "text-ok" : "text-warn"}>{d.createdAt.slice(5, 19).replace("T", " ")} {d.event} {d.status} ×{d.attempts}{d.lastStatus ? ` ${d.lastStatus}` : ""}{d.lastError ? ` ${d.lastError}` : ""}</li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ApiSettings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="space-y-8">
      <section className="border-b border-line pb-6">
        <h2 className="mb-1 text-[14px] font-semibold">API for other systems</h2>
        <p className="text-soft max-w-prose text-[12px]">
          A versioned REST API at <code className="font-mono">/api/v1</code>, described in OpenAPI: <a className="underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">/api/v1/openapi.json</a>.
          Everything an API caller does goes through the same roles, approvals, safety rules, snapshots and audit as this page. To reach it from another machine the server has to listen beyond this one (set <code className="font-mono">APP_HOST</code>; see the README).
        </p>
      </section>
      {isAdmin ? (
        <>
          <section className="border-b border-line pb-6"><Tokens /></section>
          <section><Webhooks /></section>
        </>
      ) : <p className="text-soft text-[13px]">Only an administrator can manage tokens and webhooks.</p>}
    </div>
  );
}
