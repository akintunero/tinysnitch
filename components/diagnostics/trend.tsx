import type { HistoryPoint } from "@/lib/diagnostics/store";

/**
 * Critical and warning findings over the saved runs of a network, as a small line chart. Colour is never the only cue:
 * each line is labelled, and the latest values are written out. Runs saved before counts existed are left out.
 */
export function Trend({ points }: { points: HistoryPoint[] }) {
  const pts = points.filter((p) => p.counts);
  if (pts.length < 2) return null;
  const W = 520, H = 90, PAD = 22;
  const max = Math.max(1, ...pts.flatMap((p) => [p.counts!.critical, p.counts!.warning]));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (pts.length - 1);
  const y = (v: number) => H - 14 - (v * (H - 30)) / max;
  const line = (k: "critical" | "warning") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.counts![k]).toFixed(1)}`).join(" ");
  const last = pts.at(-1)!;
  const first = pts[0];
  return (
    <figure className="mt-4 rounded-md border border-line bg-surface p-3" aria-label="Findings over time">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
        <span className="font-medium">Findings over {pts.length} runs</span>
        <span className="text-soft">now {last.counts!.critical} critical, {last.counts!.warning} warning · first run {first.counts!.critical} critical, {first.counts!.warning} warning</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Critical findings ${first.counts!.critical} to ${last.counts!.critical}, warnings ${first.counts!.warning} to ${last.counts!.warning}`} className="h-24 w-full">
        <line x1={PAD} x2={W - PAD} y1={H - 14} y2={H - 14} stroke="currentColor" strokeOpacity="0.2" />
        <path d={line("warning")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" className="text-warn" />
        <path d={line("critical")} fill="none" stroke="currentColor" strokeWidth="2" className="text-bad" />
        {pts.map((p, i) => <circle key={p.runId} cx={x(i)} cy={y(p.counts!.critical)} r="2" className="fill-current text-bad"><title>{`${new Date(p.at).toLocaleString()}: ${p.counts!.critical} critical, ${p.counts!.warning} warning`}</title></circle>)}
        <text x={PAD} y={10} className="fill-current text-[9px] text-soft">{max}</text>
        <text x={PAD} y={H - 2} className="fill-current text-[9px] text-soft">{new Date(first.at).toLocaleDateString()}</text>
        <text x={W - PAD} y={H - 2} textAnchor="end" className="fill-current text-[9px] text-soft">{new Date(last.at).toLocaleDateString()}</text>
      </svg>
      <p className="text-soft text-[11px]"><span className="text-bad">Solid line: critical.</span> <span className="text-warn">Dashed line: warning.</span></p>
    </figure>
  );
}
