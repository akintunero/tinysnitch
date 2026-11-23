import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "bad" | "idle";

const COLOR: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-muted" };
const TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-soft" };

/** A dot plus a word, so state never depends on colour alone. */
export function StatusDot({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("size-2 rounded-full", COLOR[tone])} />
      <span className={cn("text-[12px] font-medium", TEXT[tone])}>{label}</span>
    </span>
  );
}

/** What to show when there is nothing yet: say what is missing, and offer the one thing that fixes it. */
export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="border-l-2 border-line py-1 pl-4">
      <p className="text-[14px] font-medium">{title}</p>
      {children ? <p className="text-soft mt-1 max-w-prose text-[13px]">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-7 flex items-end justify-between gap-4 border-b border-line pb-4">
      <h1 className="text-[20px] font-semibold leading-7 tracking-tight">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
