"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ActivityIcon, AssistantIcon, BackupsIcon, ConfigIcon, DiagnosticsIcon, NetworksIcon, OverviewIcon, ServicesIcon, SettingsIcon, TopologyIcon } from "@/components/ui/nav-icons";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";
import { AuthScreen } from "./auth-screen";
import { claudeLabel, claudeTone, mcpTone, StatusProvider, useApp } from "./status-provider";

type Icon = typeof OverviewIcon;
const NAV: { group: string; items: { href: string; label: string; icon: Icon }[] }[] = [
  { group: "Workspace", items: [
    { href: "/", label: "Overview", icon: OverviewIcon },
    { href: "/networks", label: "Networks", icon: NetworksIcon },
    { href: "/topology", label: "Topology", icon: TopologyIcon },
  ] },
  { group: "Operate", items: [
    { href: "/assistant", label: "Assistant", icon: AssistantIcon },
    { href: "/services", label: "Services", icon: ServicesIcon },
    { href: "/configurations", label: "Configurations", icon: ConfigIcon },
    { href: "/diagnostics", label: "Diagnostics", icon: DiagnosticsIcon },
    { href: "/backups", label: "Backups", icon: BackupsIcon },
  ] },
  { group: "Record", items: [{ href: "/activity", label: "Activity", icon: ActivityIcon }] },
];

const MODE_LABEL = { suggest: "Suggest", approve: "Approve and deploy", autopilot: "Autopilot" } as const;

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { status, labs } = useApp();
  const link = (href: string, label: string, Icon: Icon, count?: number | null) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn("flex items-center gap-2.5 border-l-2 px-2.5 py-1.5 text-[13px]", active ? "border-accent bg-surface-2 font-medium" : "border-transparent text-ink hover:bg-surface-2/60")}
      >
        <Icon className={cn("size-[18px] shrink-0", active ? "text-accent" : "text-muted")} />
        {label}
        {count != null ? <span className="text-soft ml-auto font-mono text-[11px] tabular-nums">{count}</span> : null}
      </Link>
    );
  };
  return (
    <nav aria-label="Main" className="flex h-full w-56 flex-col border-r border-line bg-surface">
      <div className="flex-1 space-y-5 overflow-y-auto py-4 pr-3">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="label mb-1 pl-3">{g.group}</p>
            <div>{g.items.map((n) => link(n.href, n.label, n.icon, n.href === "/networks" && labs.labs.length ? labs.labs.length : null))}</div>
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t border-line py-3 pl-3 pr-3">
        {status?.mcp.configured === false ? null : (
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-soft">CML MCP</span>
            <StatusDot tone={mcpTone(status?.mcp.status)} label={status?.mcp.status ?? "checking"} />
          </div>
        )}
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
  const { status, settings, labs, selectLab, session, signOut } = useApp();
  const selected = settings?.selectedLabId ?? "";
  const known = labs.labs.some((l) => l.id === selected);
  const current = labs.labs.find((l) => l.id === selected);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 md:gap-3 border-b border-line bg-surface px-3 md:px-4">
      <button type="button" onClick={onMenu} aria-label="Open navigation" className="rounded-sm p-1.5 hover:bg-surface-2 md:hidden">
        <Menu className="size-4" aria-hidden />
      </button>
      <Link href="/" className="whitespace-nowrap text-[14px] font-semibold tracking-tight">Tiny Snitch</Link>
      <span className="hidden h-4 w-px bg-line sm:block" aria-hidden />
      <label className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none text-[12px]">
        <span className="text-soft hidden sm:inline">Network</span>
        <select
          aria-label="Current network"
          value={known ? selected : ""}
          disabled={labs.labs.length === 0}
          onChange={(e) => void selectLab(e.target.value || null).catch(() => undefined)}
          className="h-7 w-full min-w-0 max-w-[11rem] truncate rounded-sm border border-line bg-bg px-2 text-[12px] disabled:opacity-60 sm:max-w-xs"
        >
          <option value="">{labs.loading ? "Loading networks" : labs.labs.length ? "Select a network" : labs.error ? "Unavailable" : "No networks"}</option>
          {!known && settings?.selectedLabTitle ? <option value="" disabled>{settings.selectedLabTitle} (not found)</option> : null}
          {labs.labs.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </label>
      {current?.environment === "production" ? <Badge className="text-warn"><span title="Changes here always need a person's approval">Production</span></Badge> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
        {status?.mcp.configured === false ? null : <StatusDot className="hidden sm:inline-flex" tone={mcpTone(status?.mcp.status)} label={`CML ${status?.mcp.status ?? "checking"}`} />}
        {session?.authEnabled && session.user ? (
          <span className="flex items-center gap-2 text-[12px]">
            <span title={session.user.roleText}>{session.user.username} <span className="text-soft">({session.user.role})</span></span>
            <button type="button" onClick={() => void signOut()} className="rounded-sm border border-line px-2 py-0.5 hover:bg-surface-2">Sign out</button>
          </span>
        ) : null}
        <span className="text-soft hidden text-[12px] md:inline">Mode: {settings ? MODE_LABEL[settings.executionMode] : "..."}</span>
        <ThemeToggle />
        <Link href="/settings" aria-label="Settings" className="rounded-sm p-1.5 hover:bg-surface-2">
          <SettingsIcon className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
        </Link>
      </div>
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { statusError, session } = useApp();
  const path = usePathname();
  const wide = path.startsWith("/topology"); // the diagram needs the full width and height
  const tall = wide || path.startsWith("/assistant"); // the chat fills the height and scrolls inside itself
  if (session === null) return <div className="flex min-h-dvh items-center justify-center text-soft text-[13px]">Loading...</div>;
  if (session.setupRequired || (session.authEnabled && !session.user)) return <AuthScreen />;
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
