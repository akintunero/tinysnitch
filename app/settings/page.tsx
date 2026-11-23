"use client";

import { useEffect, useState } from "react";
import { claudeLabel, claudeTone, mcpTone, type Status, useApp } from "@/components/layout/status-provider";
import { ApiSettings } from "@/components/settings/api-settings";
import { Button } from "@/components/ui/button";
import { PageHeader, StatusDot } from "@/components/ui/status-dot";
import { ROLES, ROLE_TEXT, type Role } from "@/lib/auth/roles";
import type { User } from "@/lib/auth/store";
import { apiGet, apiSend } from "@/lib/client";
import type { ComplianceMode, ExecutionMode, PrivacyMode } from "@/lib/settings";
import { relativeTime } from "@/lib/utils";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-6 first:pt-0 last:border-0">
      <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-soft shrink-0 text-[13px]">{label}</dt>
      <dd className="min-w-0 text-right text-[13px]">{children}</dd>
    </div>
  );
}

const MODES: { id: ExecutionMode; title: string; text: string }[] = [
  { id: "suggest", title: "Suggest", text: "Changes are drafted and validated for review. Nothing can be approved or applied." },
  { id: "approve", title: "Approve and deploy", text: "Changes are validated, shown for review, and applied only after you approve them. A snapshot is taken first, the result is read back from the device, and a failed change is rolled back." },
  { id: "autopilot", title: "Autopilot", text: "A small, low-risk change (up to 30 lines on up to 3 devices, no high-risk lines) in a lab network is applied and verified by itself, and rolled back if verification fails or a new critical problem appears. Production networks always need your approval." },
];

const TABS = [
  { id: "connections", label: "Connections" },
  { id: "changes", label: "Changes" },
  { id: "privacy", label: "Privacy" },
  { id: "people", label: "People" },
  { id: "api", label: "API" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function Settings() {
  const { status, settings, updateSettings, refreshStatus, can } = useApp();
  const [tab, setTab] = useState<TabId>("connections");
  // The tab lives in the address (#privacy), so a link or a reload lands on the same one.
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if (TABS.some((t) => t.id === h)) setTab(h as TabId);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const openTab = (id: TabId) => { setTab(id); window.history.replaceState(null, "", `#${id}`); };
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reconnect" | "verify" | null>(null);

  const save = async (patch: Parameters<typeof updateSettings>[0]) => {
    try {
      await updateSettings(patch);
      setNote("Saved.");
    } catch (e) {
      setNote(`Could not save: ${(e as Error).message}`);
    }
  };
  const act = async (kind: "reconnect" | "verify") => {
    setBusy(kind);
    setNote(null);
    try {
      await apiSend("POST", kind === "reconnect" ? "/api/mcp/reconnect" : "/api/claude/verify");
      setNote(kind === "reconnect" ? "Reconnected to the MCP server." : "AI model check passed.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  };

  const mcp: Status["mcp"] | undefined = status?.mcp;
  const claude = status?.claude;

  return (
    <>
      <PageHeader title="Settings">
        <span role="status" className="text-soft text-[12px]">{note}</span>
      </PageHeader>

      <nav aria-label="Settings sections" className="-mt-2 mb-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => openTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === t.id ? "border-accent font-medium" : "border-transparent text-soft hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div hidden={tab !== "connections"}>
      <Section title="AI model">
        <dl>
          <Row label="API connection"><StatusDot tone={claudeTone(claude)} label={claudeLabel(claude)} /></Row>
          {claude?.endpoint ? <Row label="Provider">{claude.endpoint}</Row> : null}
          <Row label="Model"><span className="font-mono text-[12px]">{claude?.model ?? "not set"}</span></Row>
          {claude?.error ? <Row label="Last check"><span className="text-bad">{claude.error}</span></Row> : null}
          {claude?.checkedAt ? <Row label="Checked">{relativeTime(claude.checkedAt)}</Row> : null}
        </dl>
        <p className="text-soft mt-2 text-[12px]">
          The provider, model and key come from <code className="font-mono">LLM_PROVIDER</code>, <code className="font-mono">LLM_MODEL</code>, <code className="font-mono">LLM_BASE_URL</code> and <code className="font-mono">LLM_API_KEY</code> in <code className="font-mono">.env.local</code>
          (<code className="font-mono">ANTHROPIC_API_KEY</code> and <code className="font-mono">ANTHROPIC_MODEL</code> still work). Any OpenAI-compatible server, local models included, can be used.
          The key stays on the server and is never shown here. Restart the app after changing it.
        </p>
        <div className="mt-3"><Button onClick={() => void act("verify")} disabled={!claude?.configured || busy !== null}>{busy === "verify" ? "Checking" : "Verify connection"}</Button></div>
      </Section>

      <Section title="MCP server (lab simulators, optional)">
        <dl>
          <Row label="Status"><StatusDot tone={mcpTone(mcp?.status)} label={mcp?.status ?? "checking"} /></Row>
          <Row label="Transport">{mcp?.transport ?? "not configured"}</Row>
          <Row label="Command or endpoint"><span className="block text-left font-mono text-[12px] [overflow-wrap:anywhere]">{mcp?.endpoint ?? "none"}</span></Row>
          {mcp?.server ? <Row label="Server">{mcp.server.name} {mcp.server.version}</Row> : null}
          <Row label="Tools discovered">{mcp?.toolCount ?? 0}</Row>
          <Row label="Last attempt">{relativeTime(mcp?.lastAttempt)}</Row>
          {mcp?.lastError ? <Row label="Last error"><span className="text-bad">{mcp.lastError}</span></Row> : null}
          {mcp && !mcp.configured ? <Row label="Configuration"><span className="text-bad">{mcp.configError}</span></Row> : null}
        </dl>
        <p className="text-soft mt-2 text-[12px]">Set in <code className="font-mono">.env.local</code>. Variable names are shown; credentials and header values never are.</p>
        <div className="mt-3"><Button onClick={() => void act("reconnect")} disabled={!mcp?.configured || busy !== null}>{busy === "reconnect" ? "Reconnecting" : "Reconnect"}</Button></div>
      </Section>

      <Section title="Network sources">
        <Sources />
      </Section>
      </div>

      <div hidden={tab !== "changes"}>
      <Section title="Maintenance window">
        <MaintenanceWindowEditor />
      </Section>

      <Section title="Changes and checks">
        {!settings ? <p className="text-soft text-[13px]">Loading...</p> : (
          <>
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium">Default execution mode</legend>
              <div className="space-y-2">
                {MODES.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-start gap-2.5">
                    <input type="radio" name="mode" className="mt-1 accent-accent" checked={settings.executionMode === m.id} onChange={() => void save({ executionMode: m.id })} />
                    <span><span className="text-[13px] font-medium">{m.title}</span><span className="text-soft block text-[12px]">{m.text}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 space-y-2.5">
              <Check checked={settings.diagnosticsOnLabSelect} onChange={(v) => void save({ diagnosticsOnLabSelect: v })} title="Run read-only diagnostics when a network is selected" text="Runs in the background after you choose a network. It only reads." />
              <label className="block">
                <span className="text-[13px] font-medium">Security and hygiene baseline in Diagnostics</span>
                <select value={settings.complianceChecks} onChange={(e) => void save({ complianceChecks: e.target.value as ComplianceMode })} className="mt-1 block h-8 rounded-sm border border-line bg-bg px-2 text-[13px]">
                  <option value="production">Production networks only (default)</option>
                  <option value="all">All networks, test networks included</option>
                  <option value="off">Off</option>
                </select>
                <span className="text-soft block text-[12px]">SSH version 2, Telnet on VTY lines, clear-text passwords, default SNMP communities, the HTTP server, NTP, syslog and AAA, on IOS devices. It can be noise on test networks, which is why they are skipped by default.</span>
              </label>
              <Check checked={settings.requireSecondApprover} onChange={(v) => void save({ requireSecondApprover: v })} title="Require a second person to approve production changes" text="The person who proposed a change to a production network cannot be the one who approves it, as long as another approver exists. Only applies while login is on; if nobody else can approve, it is allowed and recorded." />
              <Check checked={settings.requireDeviceReadiness} onChange={(v) => void save({ requireDeviceReadiness: v })} title="Require each device to be ready before a production change touches it" text="A device needs a recent backup, no unreviewed changes made outside Tiny Snitch, and a person's sign-off (on the Backups page). A change that touches a device that is not ready is refused when it is proposed, and again when it is applied. Labs are never held to it." />
              <Check checked={settings.autopilotAllowConfig} disabled={settings.executionMode !== "autopilot"} onChange={(v) => void save({ autopilotAllowConfig: v })} title="Let Autopilot apply configuration changes" text="Off by default. Even when on, it applies only small, low-risk changes in lab networks; high-risk lines, changes that would cut off Tiny Snitch's own access, and anything in production always need a person." />
            </div>
            <p className="text-soft mt-4 text-[12px]">Every change takes a snapshot of each device first; that is not optional, because rollback depends on it. Lines that erase, reload, copy files or clear state are never sent. Every operation is recorded in Activity.</p>
          </>
        )}
      </Section>
      </div>

      <div hidden={tab !== "privacy"}>
        <Section title="Sending data to the AI model">
          {!settings ? <p className="text-soft text-[13px]">Loading...</p> : (
            <div className="space-y-4">
              <label className="block">
                <span className="text-[13px] font-medium">Hide identifying data from the AI model</span>
                <select value={settings.llmPrivacy} onChange={(e) => void save({ llmPrivacy: e.target.value as PrivacyMode })} className="mt-1 block h-8 rounded-sm border border-line bg-bg px-2 text-[13px]">
                  <option value="production">Production networks only (default)</option>
                  <option value="all">All networks, test networks included</option>
                  <option value="off">Off: send real values</option>
                </select>
                <span className="text-soft block text-[12px]">IP and IPv6 addresses, device and network names, MAC addresses, user and domain names, descriptions and banners are replaced with stand-ins before anything is sent to the AI model, and put back in what you read. Addresses in the same subnet stay in the same subnet, so the model can still reason about the topology. The mapping stays in this server's memory. Credentials are always removed. Each request is recorded in Activity with what was replaced.</span>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Words to always hide from the AI model</span>
                <textarea
                  key={settings.llmPrivateTerms.join("|")}
                  defaultValue={settings.llmPrivateTerms.join("\n")}
                  rows={3}
                  placeholder="One per line: customer names, site names, project names"
                  onBlur={(e) => void save({ llmPrivateTerms: e.target.value.split(/[\n,]/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 100) })}
                  className="mt-1 block w-full max-w-md rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-[12px] placeholder:text-muted"
                />
                <span className="text-soft block text-[12px]">Names of route-maps, prefix-lists, ACLs, VRFs and similar objects, public AS numbers, hostnames and domains are found automatically. Add anything else that identifies a customer or site and would not be recognised, such as a name inside free text.</span>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium">Words that are safe to show the AI model</span>
                <textarea
                  key={settings.llmSafeWords.join("|")}
                  defaultValue={settings.llmSafeWords.join("\n")}
                  rows={2}
                  placeholder="One per line: words that describe a purpose, such as VOICE or BRANCH"
                  onBlur={(e) => void save({ llmSafeWords: e.target.value.split(/[\n,]/).map((t) => t.trim()).filter(Boolean).slice(0, 200) })}
                  className="mt-1 block w-full max-w-md rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-[12px] placeholder:text-muted"
                />
                <span className="text-soft block text-[12px]">Object names are split into words. Generic ones (IN, OUT, GUEST, UPLINK, MGMT and similar) are kept so the model can read the purpose; any other word is replaced. Add words here that describe purpose in your naming, never a customer or site name.</span>
              </label>
            </div>
          )}
        </Section>
      </div>

      <div hidden={tab !== "people"}>
        <Section title="Login and users">
          <LoginAndUsers />
        </Section>
      </div>

      {tab === "api" ? <ApiSettings isAdmin={can("admin")} /> : null}
    </>
  );
}

function Check({ checked, onChange, title, text, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-1 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="text-[13px] font-medium">{title}</span><span className="text-soft block text-[12px]">{text}</span></span>
    </label>
  );
}

type ProvidersInfo = { providers: { id: string; kind: string; label: string }[]; problems: { provider: string; message: string }[]; configured: { cml: boolean; inventoryFile: boolean; ansible: boolean; netbox: boolean } };

function Sources() {
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  useEffect(() => { apiGet<ProvidersInfo>("/api/providers").then(setInfo).catch(() => undefined); }, []);
  if (!info) return <p className="text-soft text-[13px]">Loading...</p>;
  const on = (k: string) => info.providers.some((p) => p.kind === k);
  return (
    <>
      <dl>
        <Row label="Cisco Modeling Labs"><StatusDot tone={on("cml") ? "ok" : "idle"} label={on("cml") ? "configured" : "not configured"} /></Row>
        <Row label="Inventory file"><StatusDot tone={on("static") ? "ok" : info.configured.inventoryFile ? "bad" : "idle"} label={on("static") ? "loaded" : info.configured.inventoryFile ? "has a problem" : "not set"} /></Row>
        <Row label="Ansible inventory"><StatusDot tone={on("ansible") ? "ok" : info.configured.ansible ? "bad" : "idle"} label={on("ansible") ? "loaded" : info.configured.ansible ? "has a problem" : "not set"} /></Row>
        <Row label="Discovery"><StatusDot tone={on("discovery") ? "ok" : "idle"} label={on("discovery") ? "defined" : "none defined"} /></Row>
        <Row label="NetBox"><StatusDot tone={on("netbox") ? "ok" : info.configured.netbox ? "bad" : "idle"} label={on("netbox") ? "configured" : info.configured.netbox ? "has a problem" : "not set"} /></Row>
      </dl>
      {info.problems.map((p) => <p key={p.message} className="mt-2 text-[13px] text-bad">{p.provider}: {p.message}</p>)}
      <p className="text-soft mt-2 text-[12px]">
        Real devices are reached over SSH, NETCONF (Junos), Arista eAPI or Cisco NX-API using <code className="font-mono">TS_INVENTORY_FILE</code> (sites, devices, a transport per device, and credential <em>references</em>, never passwords), an Ansible inventory (<code className="font-mono">TS_ANSIBLE_INVENTORY</code>) or NetBox (SSH only)
        (<code className="font-mono">NETBOX_URL</code>, <code className="font-mono">NETBOX_TOKEN</code>, <code className="font-mono">NETBOX_SSH_USERNAME</code> plus <code className="font-mono">NETBOX_SSH_PASSWORD</code> or <code className="font-mono">NETBOX_SSH_KEY_FILE</code>).
        These are set in <code className="font-mono">.env.local</code>; restart the app after changing them. See the README for the file format.
      </p>
    </>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MaintenanceWindowEditor() {
  const { settings, updateSettings } = useApp();
  const [err, setErr] = useState<string | null>(null);
  if (!settings) return <p className="text-soft text-[13px]">Loading...</p>;
  const w = settings.maintenanceWindow;
  const save = async (patch: Partial<typeof w>) => {
    setErr(null);
    try { await updateSettings({ maintenanceWindow: { ...w, ...patch } }); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="text-[13px]">
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-1 accent-accent" checked={w.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span><span className="font-medium">Only apply changes to production networks inside this window</span><span className="text-soft block text-[12px]">Labs are never held to it. A change outside it can be scheduled for inside it, or applied anyway by someone who gives a reason, which is recorded in Activity.</span></span>
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <span className="flex gap-1.5">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-0.5"><input type="checkbox" className="accent-accent" checked={w.days.includes(i)} onChange={(e) => void save({ days: e.target.checked ? [...w.days, i].sort() : w.days.filter((x) => x !== i) })} />{d}</label>)}</span>
        <label>From <input type="time" className="ml-1 h-7 rounded-sm border border-line bg-bg px-1.5" value={w.start} onChange={(e) => e.target.value && void save({ start: e.target.value })} /></label>
        <label>to <input type="time" className="ml-1 h-7 rounded-sm border border-line bg-bg px-1.5" value={w.end} onChange={(e) => e.target.value && void save({ end: e.target.value })} /></label>
        <label>Time zone <input className="ml-1 h-7 w-40 rounded-sm border border-line bg-bg px-1.5" defaultValue={w.timezone} onBlur={(e) => e.target.value !== w.timezone && void save({ timezone: e.target.value })} placeholder="Europe/London" /></label>
      </div>
      <p className="text-soft mt-1 text-[11px]">A window that ends before it starts runs overnight, and belongs to the day it starts.</p>
      {err ? <p role="alert" className="mt-1 text-[12px] text-bad">{err}</p> : null}
    </div>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiSend("POST", "/api/auth/password", { current, next });
      setCurrent(""); setNext("");
      setMsg({ ok: true, text: "Password changed. Your other sessions were signed out." });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };
  const field = "mt-0.5 block h-8 w-56 rounded-sm border border-line bg-bg px-2 text-[13px]";
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-wrap items-end gap-3 text-[12px]">
      <label>Current password<input className={field} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
      <label>New password (12 or more characters)<input className={field} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></label>
      <Button type="submit" disabled={!current || !next}>Change password</Button>
      {msg ? <span role="status" className={msg.ok ? "text-ok" : "text-bad"}>{msg.text}</span> : null}
    </form>
  );
}

function LoginAndUsers() {
  const { session, refreshSession } = useApp();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "operator" as Role });
  const [reset, setReset] = useState<{ id: string; password: string } | null>(null);
  const isAdmin = session?.user?.role === "admin";

  const load = async () => {
    try { setUsers((await apiGet<{ users: User[] }>("/api/users")).users); setError(null); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]);

  if (!session) return <p className="text-soft text-[13px]">Loading...</p>;

  if (!session.authEnabled) {
    return (
      <div className="text-[13px]">
        <p>Login is <span className="font-medium">off</span>: anyone who can reach this app on this machine can use it, which is fine while it listens on this machine only. Turn it on to give people their own accounts and roles, and to name them in the Activity log.</p>
        <form className="mt-3 flex flex-wrap items-end gap-3 text-[12px]" onSubmit={(e) => { e.preventDefault(); void apiSend("POST", "/api/auth/setup", { username: form.username, password: form.password }).then(() => refreshSession()).catch((err) => setError((err as Error).message)); }}>
          <label>Administrator username<input className="mt-0.5 block h-8 w-48 rounded-sm border border-line bg-bg px-2 text-[13px]" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
          <label>Password (12 or more characters)<input className="mt-0.5 block h-8 w-56 rounded-sm border border-line bg-bg px-2 text-[13px]" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
          <Button variant="primary" type="submit" disabled={!form.username || !form.password}>Turn on login</Button>
        </form>
        {error ? <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="text-[13px]">
      <p>Signed in as <span className="font-medium">{session.user?.username}</span> ({session.user?.role}). {session.user?.roleText}</p>
      <PasswordForm />
      {!isAdmin ? <p className="text-soft mt-4 text-[12px]">Only administrators manage users.</p> : (
        <div className="mt-6">
          <h3 className="mb-1 text-[13px] font-semibold">Users</h3>
          {error ? <p role="alert" className="mb-2 text-[13px] text-bad">{error}</p> : null}
          <table className="w-full text-left text-[12px]">
            <thead className="text-soft border-b border-line"><tr><th className="py-1 font-medium">User</th><th className="font-medium">Role</th><th className="font-medium">Last sign-in</th><th /></tr></thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id} className="border-b border-line align-top last:border-0">
                  <td className="py-1.5 font-medium">{u.username}{u.disabled ? <span className="text-soft font-normal"> (disabled)</span> : null}</td>
                  <td><select className="h-7 rounded-sm border border-line bg-bg px-1.5" value={u.role} onChange={(e) => void apiSend("PUT", `/api/users/${u.id}`, { role: e.target.value }).then(load).catch((err) => setError((err as Error).message))}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></td>
                  <td className="text-soft">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : "never"}</td>
                  <td className="space-x-2 py-1 text-right">
                    {reset?.id === u.id ? (
                      <span className="inline-flex gap-1"><input className="h-7 w-44 rounded-sm border border-line bg-bg px-1.5" type="password" placeholder="New password" autoComplete="new-password" value={reset.password} onChange={(e) => setReset({ id: u.id, password: e.target.value })} /><Button size="sm" onClick={() => void apiSend("PUT", `/api/users/${u.id}`, { password: reset.password }).then(() => { setReset(null); return load(); }).catch((err) => setError((err as Error).message))}>Set</Button></span>
                    ) : <Button size="sm" variant="ghost" onClick={() => setReset({ id: u.id, password: "" })}>Reset password</Button>}
                    <Button size="sm" variant="ghost" onClick={() => void apiSend("PUT", `/api/users/${u.id}`, { disabled: !u.disabled }).then(load).catch((err) => setError((err as Error).message))}>{u.disabled ? "Enable" : "Disable"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Delete ${u.username}? They are signed out at once.`)) void apiSend("DELETE", `/api/users/${u.id}`).then(load).catch((err) => setError((err as Error).message)); }}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="mt-4 flex flex-wrap items-end gap-3 text-[12px]" onSubmit={(e) => { e.preventDefault(); void apiSend("POST", "/api/users", form).then(() => { setForm({ username: "", password: "", role: "operator" }); return load(); }).catch((err) => setError((err as Error).message)); }}>
            <label>New user<input className="mt-0.5 block h-8 w-40 rounded-sm border border-line bg-bg px-2 text-[13px]" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
            <label>Password<input className="mt-0.5 block h-8 w-48 rounded-sm border border-line bg-bg px-2 text-[13px]" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
            <label>Role<select className="mt-0.5 block h-8 rounded-sm border border-line bg-bg px-2 text-[13px]" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
            <Button type="submit" disabled={!form.username || !form.password}>Add user</Button>
          </form>
          <ul className="text-soft mt-3 space-y-0.5 text-[11px]">{ROLES.map((r) => <li key={r}><span className="font-medium">{r}</span>: {ROLE_TEXT[r]}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
