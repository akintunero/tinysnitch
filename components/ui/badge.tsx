import { cn } from "@/lib/utils";

/** A short state or category label: outlined, in the colour of what it states. Pass the colour as a text-* class. */
export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-sm border border-current/40 px-1.5 py-px text-[10.5px] font-semibold uppercase leading-4 tracking-wide", className)}>{children}</span>;
}
