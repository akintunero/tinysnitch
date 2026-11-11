"use client";

import { FileCode, FlaskConical, History, House, Menu, MessageSquare, Network, Settings as SettingsIcon, Stethoscope, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { claudeLabel, claudeTone, mcpTone, StatusProvider, useApp } from "./status-provider";

const NAV = [
  { href: "/", label: "Overview", icon: House },
  { href: "/labs", label: "Networks", icon: FlaskConical },
  { href: "/topology", label: "Topology", icon: Network },
  { href: "/assistant", label: "Network Assistant", icon: MessageSquare },
  { href: "/configurations", label: "Configurations", icon: FileCode },
  { href: "/diagnostics", label: "Diagnostics", icon: Stethoscope },
  { href: "/activity", label: "Activity", icon: History },
];

const MODE_LABEL = { suggest: "Suggest", approve: "Approve and deploy", autopilot: "Autopilot" } as const;

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { status } = useApp();
  const link = (href: string, label: string, Icon: typeof House) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn("flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px]", active ? "bg-ink text-bg" : "text-ink hover:bg-surface-2")}
      >
        <Icon className={cn("size-4 shrink-0", active ? "text-bg" : "text-muted")} strokeWidth={1.75} aria-hidden />
        {label}
      </Link>
    );
  };
  return (
    <nav aria-label="Main" className="flex h-full w-56 flex-col border-r border-line bg-surface">
      <div className="flex-1 space-y-0.5 p-3">{NAV.map((n) => link(n.href, n.label, n.icon))}</div>
      <div className="space-y-2 border-t border-line p-3">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-soft">CML MCP</span>
          <StatusDot tone={mcpTone(status?.mcp.status)} label={status?.mcp.status ?? "checking"} />
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-soft">Claude API</span>
          <StatusDot tone={claudeTone(status?.claude)} label={claudeLabel(status?.claude)} />
        </div>
        <div className="pt-1">{link("/settings", "Settings", SettingsIcon)}</div>
      </div>
    </nav>
  );
}

function Header({ onMenu }: { onMenu: () => void }) {
  const { status, settings, labs, selectLab } = useApp();
  const selected = settings?.selectedLabId ?? "";
  const known = labs.labs.some((l) => l.id === selected);
  const current = labs.labs.find((l) => l.id === selected);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 md:px-4">
      <button type="button" onClick={onMenu} aria-label="Open navigation" className="rounded-sm p-1.5 hover:bg-surface-2 md:hidden">
        <Menu className="size-4" aria-hidden />
      </button>
      <Link href="/" className="text-[14px] font-semibold tracking-tight">Tiny Snitch</Link>
      <span className="hidden h-4 w-px bg-line sm:block" aria-hidden />
      <label className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="text-soft hidden sm:inline">Network</span>
        <select
          aria-label="Current network"
          value={known ? selected : ""}
          disabled={labs.labs.length === 0}
          onChange={(e) => void selectLab(e.target.value || null).catch(() => undefined)}
          className="h-7 max-w-[11rem] truncate rounded-sm border border-line bg-bg px-2 text-[12px] disabled:opacity-60 sm:max-w-xs"
        >
          <option value="">{labs.loading ? "Loading networks" : labs.labs.length ? "Select a network" : labs.error ? "Unavailable" : "No networks"}</option>
          {!known && settings?.selectedLabTitle ? <option value="" disabled>{settings.selectedLabTitle} (not found)</option> : null}
          {labs.labs.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </label>
      {current?.environment === "production" ? <span className="rounded-sm border border-warn px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warn" title="Changes here always need a person's approval">Production</span> : null}
      <div className="ml-auto flex items-center gap-4">
        <StatusDot className="hidden sm:inline-flex" tone={mcpTone(status?.mcp.status)} label={`CML ${status?.mcp.status ?? "checking"}`} />
        <span className="text-soft hidden text-[12px] md:inline">Mode: {settings ? MODE_LABEL[settings.executionMode] : "..."}</span>
        <Link href="/settings" aria-label="Settings" className="rounded-sm p-1.5 hover:bg-surface-2">
          <SettingsIcon className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
        </Link>
      </div>
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { statusError } = useApp();
  const path = usePathname();
  const wide = path.startsWith("/topology"); // the diagram needs the full width and height
  const tall = wide || path.startsWith("/assistant"); // the chat fills the height and scrolls inside itself
  return (
    <div className="flex h-dvh flex-col">
      <Header onMenu={() => setOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <div className="hidden md:block"><Sidebar /></div>
        {open ? (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
            <div className="relative h-full w-56">
              <Sidebar onNavigate={() => setOpen(false)} />
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute right-2 top-2 rounded-sm p-1.5 hover:bg-surface-2">
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </div>
        ) : null}
        <main className={cn("min-w-0 flex-1", tall ? "overflow-hidden" : "overflow-auto")}>
          {statusError ? <p role="alert" className="border-b border-bad/40 bg-surface px-4 py-2 text-[13px] text-bad">Cannot reach the Tiny Snitch server: {statusError}</p> : null}
          <div className={cn("p-4 md:p-6", tall && "h-full", !wide && (tall ? "mx-auto max-w-3xl" : "mx-auto max-w-5xl"))}>{children}</div>
        </main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <StatusProvider>
      <Shell>{children}</Shell>
    </StatusProvider>
  );
}
