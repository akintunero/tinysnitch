"use client";

import type { Part } from "@/lib/assistant/history";
import { cn } from "@/lib/utils";

type ToolPart = Extract<Part, { type: "tool" }>;

/** A one-line summary of what was asked of the lab, so the engineer can see what Claude actually did. */
export function describeCall(tool: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const command = typeof args.commands === "string" ? args.commands : typeof args.command === "string" ? args.command : null;
  const target = typeof args.label === "string" ? args.label : null;
  if (command) return `${command.trim().slice(0, 80)}${target ? ` on ${target}` : ""}`;
  return tool;
}

export function ToolCall({ part }: { part: ToolPart }) {
  const running = part.ok === null;
  const status = running ? "running" : part.ok ? "ok" : "failed";
  return (
    <details className="group my-2 rounded-sm border border-line bg-surface text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
        <span className={cn("shrink-0 font-semibold", running ? "text-warn" : part.ok ? "text-ok" : "text-bad")}>{status}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{describeCall(part.tool, part.input)}</span>
        {part.ms !== null ? <span className="text-soft shrink-0">{part.ms} ms</span> : null}
      </summary>
      <div className="space-y-2 border-t border-line p-2.5">
        <div>
          <div className="text-soft mb-0.5 text-[11px]">Tool {part.tool}, arguments</div>
          <pre className="overflow-x-auto rounded-sm bg-surface-2 p-2 font-mono text-[11px]">{JSON.stringify(part.input, null, 2)}</pre>
        </div>
        <div>
          <div className="text-soft mb-0.5 text-[11px]">Output (secrets masked)</div>
          <pre className="max-h-64 overflow-auto rounded-sm bg-ink p-2 font-mono text-[11px] text-surface-2">{running ? "Waiting for CML..." : part.output || "(no output)"}</pre>
        </div>
      </div>
    </details>
  );
}
