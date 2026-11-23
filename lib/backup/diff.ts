/** A line diff for configurations, with context, small enough to read in a browser. */
export type DiffLine = { op: " " | "+" | "-" | "~"; text: string };
export type Diff = { lines: DiffLine[]; added: number; removed: number; truncated: boolean };

const CELL_LIMIT = 4_000_000; // beyond this the middle is shown as wholesale replaced rather than aligned

export function diffOps(a: string[], b: string[]): { op: " " | "+" | "-"; text: string }[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text) => ({ op: " " as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: " " as const, text }));
  const x = a.slice(start, endA), y = b.slice(start, endB);
  const mid: { op: " " | "+" | "-"; text: string }[] = [];
  if (x.length * y.length > CELL_LIMIT) {
    mid.push(...x.map((text) => ({ op: "-" as const, text })), ...y.map((text) => ({ op: "+" as const, text })));
  } else {
    // Longest common subsequence of the differing middle.
    const w = y.length + 1;
    const dp = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { mid.push({ op: " ", text: x[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) mid.push({ op: "-", text: x[i++] });
      else mid.push({ op: "+", text: y[j++] });
    }
    while (i < x.length) mid.push({ op: "-", text: x[i++] });
    while (j < y.length) mid.push({ op: "+", text: y[j++] });
  }
  return [...head, ...mid, ...tail];
}

/** The differences between two texts, keeping `context` unchanged lines around each change. */
export function lineDiff(before: string, after: string, context = 3, maxLines = 2000): Diff {
  const ops = diffOps(before.split(/\r?\n/), after.split(/\r?\n/));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true; });
  const lines: DiffLine[] = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) { lines.push({ op: "~", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` }); skipped = 0; }
      lines.push(o);
    } else skipped++;
  });
  if (skipped && lines.length) lines.push({ op: "~", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  const added = ops.filter((o) => o.op === "+").length, removed = ops.filter((o) => o.op === "-").length;
  return lines.length > maxLines ? { lines: lines.slice(0, maxLines), added, removed, truncated: true } : { lines, added, removed, truncated: false };
}
