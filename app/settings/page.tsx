"use client";

import { useEffect, useState } from "react";
import { claudeLabel, claudeTone, mcpTone, type Status, useApp } from "@/components/layout/status-provider";
import { Button } from "@/components/ui/button";
import { PageHeader, StatusDot } from "@/components/ui/status-dot";
import { apiGet, apiSend } from "@/lib/client";
import type { ExecutionMode } from "@/lib/settings";
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

export default function Settings() {
  const { status, settings, updateSettings, refreshStatus } = useApp();
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
      setNote(kind === "reconnect" ? "Reconnected to the CML MCP server." : "Claude API check passed.");
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

      <Section title="Claude">
        <dl>
          <Row label="API connection"><StatusDot tone={claudeTone(claude)} label={claudeLabel(claude)} /></Row>
          <Row label="Model"><span className="font-mono text-[12px]">{claude?.model ?? "not set"}</span></Row>
          {claude?.error ? <Row label="Last check"><span className="text-bad">{claude.error}</span></Row> : null}
          {claude?.checkedAt ? <Row label="Checked">{relativeTime(claude.checkedAt)}</Row> : null}
        </dl>
        <p className="text-soft mt-2 text-[12px]">
          The API key and model come from <code className="font-mono">ANTHROPIC_API_KEY</code> and <code className="font-mono">ANTHROPIC_MODEL</code> in <code className="font-mono">.env.local</code>.
          The key stays on the server and is never shown here. Restart the app after changing it.
        </p>
        <div className="mt-3"><Button onClick={() => void act("verify")} disabled={!claude?.configured || busy !== null}>{busy === "verify" ? "Checking" : "Verify connection"}</Button></div>
      </Section>

      <Section title="Cisco CML MCP">
        <dl>
          <Row label="Status"><StatusDot tone={mcpTone(mcp?.status)} label={mcp?.status ?? "checking"} /></Row>
          <Row label="Transport">{mcp?.transport ?? "not configured"}</Row>
          <Row label="Command or endpoint"><span className="font-mono text-[12px] break-all">{mcp?.endpoint ?? "none"}</span></Row>
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

      <Section title="Network operations">
        {!settings ? <p className="text-soft text-[13px]">Loading...</p> : (
          <>
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium">Default execution mode</legend>
              <div className="space-y-2">
                {MODES.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-start gap-2.5">
                    <input type="radio" name="mode" className="mt-1 accent-ink" checked={settings.executionMode === m.id} onChange={() => void save({ executionMode: m.id })} />
                    <span><span className="text-[13px] font-medium">{m.title}</span><span className="text-soft block text-[12px]">{m.text}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 space-y-2.5">
              <Check checked={settings.diagnosticsOnLabSelect} onChange={(v) => void save({ diagnosticsOnLabSelect: v })} title="Run read-only diagnostics when a network is selected" text="Runs in the background after you choose a network. It only reads." />
              <Check checked={settings.autopilotAllowConfig} disabled={settings.executionMode !== "autopilot"} onChange={(v) => void save({ autopilotAllowConfig: v })} title="Let Autopilot apply configuration changes" text="Off by default. Even when on, it applies only small, low-risk changes in lab networks; high-risk lines, changes that would cut off Tiny Snitch's own access, and anything in production always need a person." />
            </div>
            <p className="text-soft mt-4 text-[12px]">Every change takes a snapshot of each device first; that is not optional, because rollback depends on it. Lines that erase, reload, copy files or clear state are never sent. Every operation is recorded in Activity.</p>
          </>
        )}
      </Section>
    </>
  );
}

function Check({ checked, onChange, title, text, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-1 accent-ink" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="text-[13px] font-medium">{title}</span><span className="text-soft block text-[12px]">{text}</span></span>
    </label>
  );
}

type ProvidersInfo = { providers: { id: string; kind: string; label: string }[]; problems: { provider: string; message: string }[]; configured: { cml: boolean; inventoryFile: boolean; netbox: boolean } };

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
        <Row label="Discovery"><StatusDot tone={on("discovery") ? "ok" : "idle"} label={on("discovery") ? "defined" : "none defined"} /></Row>
        <Row label="NetBox"><StatusDot tone={on("netbox") ? "ok" : info.configured.netbox ? "bad" : "idle"} label={on("netbox") ? "configured" : info.configured.netbox ? "has a problem" : "not set"} /></Row>
      </dl>
      {info.problems.map((p) => <p key={p.message} className="mt-2 text-[13px] text-bad">{p.provider}: {p.message}</p>)}
      <p className="text-soft mt-2 text-[12px]">
        Real devices are reached over SSH, NETCONF (Junos), Arista eAPI or Cisco NX-API using <code className="font-mono">TS_INVENTORY_FILE</code> (sites, devices, a transport per device, and credential <em>references</em>, never passwords) or NetBox (SSH only)
        (<code className="font-mono">NETBOX_URL</code>, <code className="font-mono">NETBOX_TOKEN</code>, <code className="font-mono">NETBOX_SSH_USERNAME</code> plus <code className="font-mono">NETBOX_SSH_PASSWORD</code> or <code className="font-mono">NETBOX_SSH_KEY_FILE</code>).
        These are set in <code className="font-mono">.env.local</code>; restart the app after changing them. See the README for the file format.
      </p>
    </>
  );
}
