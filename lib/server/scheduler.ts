import { deliverDue } from "../api/webhooks";
import { reconcileAll } from "../provisioning/instances";
import { runBackups } from "../backup/engine";
import { ChangeError, assertDeployable, deployChange } from "../changes/engine";
import { dueScheduled, updateChange } from "../changes/store";
import { jobLastRun, markJobRun } from "../backup/store";
import { addAudit, getSettings } from "../database/repo";
import { runDiagnostics } from "../diagnostics/engine";
import type { Settings } from "../settings";
import { getContext } from "./context";

/**
 * Runs the read-only jobs a person switched on for a network: configuration backups and diagnostics, each every N
 * minutes. It only reads. Nothing here ever changes a device, and a job is skipped while a change is being applied.
 */
export type Job = { kind: "backup" | "diagnostics"; scope: string; key: string };

/** Which jobs are due now, given the settings and when each last ran. Pure, so it can be tested without a clock. */
export function dueJobs(s: Pick<Settings, "monitoredScopes" | "backupIntervalMinutes" | "diagnosticsIntervalMinutes">, lastRun: (key: string) => number | null, now: number): Job[] {
  const out: Job[] = [];
  for (const scope of s.monitoredScopes) {
    for (const [kind, minutes] of [["backup", s.backupIntervalMinutes], ["diagnostics", s.diagnosticsIntervalMinutes]] as const) {
      if (minutes <= 0) continue;
      const key = `${kind}:${scope}`;
      const last = lastRun(key);
      if (last === null || now - last >= minutes * 60_000) out.push({ kind, scope, key });
    }
  }
  return out;
}

let running = false;

/** One pass over whatever is due. A failing job is logged and does not stop the others; it is retried next interval. */
export async function schedulerTick(now = Date.now()): Promise<{ ran: string[]; failed: string[] }> {
  const ran: string[] = [], failed: string[] = [];
  if (running) return { ran, failed };
  running = true;
  try {
    const ctx = getContext();
    // Changes a person approved and set for a time. Each is checked again as it starts, including the maintenance window.
    for (const c of dueScheduled(ctx.db, new Date(now))) {
      try {
        assertDeployable(c.id);
      } catch (e) {
        if (e instanceof ChangeError && /Another change is being applied/.test(e.message)) continue; // try again next tick
        updateChange(ctx.db, c.id, { scheduledFor: null });
        failed.push(`change:${c.id}`);
        addAudit(ctx.db, { kind: "error", actor: "scheduler", summary: `Scheduled change "${c.title}" was not applied and its schedule was cleared: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}` });
        continue;
      }
      addAudit(ctx.db, { kind: "configuration", actor: "scheduler", summary: `Starting scheduled change "${c.title}"`, data: { changeId: c.id } });
      try { await deployChange(c.id); ran.push(`change:${c.id}`); } catch { failed.push(`change:${c.id}`); }
    }
    // A service follows the change filed for it; one finished by someone else moves along here even if nobody opens the page.
    try { reconcileAll(ctx.db); } catch { /* read again next tick */ }
    // Webhook deliveries that failed earlier come due again here; a new event is sent as soon as it is raised.
    try { await deliverDue(ctx.db, now); } catch { /* retried on the next tick */ }
    const jobs = dueJobs(getSettings(ctx.db), (k) => jobLastRun(ctx.db, k), now);
    for (const j of jobs) {
      try {
        if (j.kind === "backup") await runBackups(j.scope, "scheduled", "scheduler");
        else await runDiagnostics(j.scope, { pings: true });
        markJobRun(ctx.db, j.key, new Date(now));
        ran.push(j.key);
      } catch (e) {
        // Mark it too, so a network that is down is retried at the next interval and not hammered every minute.
        markJobRun(ctx.db, j.key, new Date(now));
        failed.push(j.key);
        addAudit(ctx.db, { kind: "error", actor: "scheduler", summary: `Scheduled ${j.kind} of ${j.scope} did not run: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` });
      }
    }
  } finally {
    running = false;
  }
  return { ran, failed };
}

const g = globalThis as unknown as { __tsScheduler?: NodeJS.Timeout };

export function startScheduler(everyMs = 60_000): void {
  if (g.__tsScheduler) return;
  const t = setInterval(() => { void schedulerTick().catch(() => undefined); }, everyMs);
  t.unref();
  g.__tsScheduler = t;
}
