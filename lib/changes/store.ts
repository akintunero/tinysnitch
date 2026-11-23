import { randomUUID } from "node:crypto";
import type { Environment, Platform } from "../core/types";
import type { LineAssessment } from "../core/safety";
import { emitEvent } from "../api/webhooks";
import type { Db } from "../database/db";

export type ChangeStatus =
  | "proposed" | "approved" | "deploying" | "paused" | "verified" | "failed" | "rolling_back" | "rolled_back" | "rollback_failed" | "rejected";

export type DevicePlan = { deviceId: string; label: string; platform: Platform; commands: string[]; risks: LineAssessment[] };
/** All at once, or a few devices first. `canary` devices (the first in the plan) are applied and verified before the rest. */
export type Rollout = { mode: "all" | "staged"; canary: number; pauseAfterCanary: boolean };
export type Plan = { devices: DevicePlan[]; warnings: string[]; rollout?: Rollout };

export type DeviceOutcome = {
  label: string;
  /** What happened on this device, in order. Each entry is a plain sentence a person can read. */
  steps: string[];
  pushed: boolean;
  verified: boolean | null;
  mismatches: { command: string; expected: string }[];
  rolledBack: boolean | null;
  remaining: string[];
};

export type ChangeResult = {
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  devices: DeviceOutcome[];
  /** Findings that appeared after the change and were not there before it. */
  regressions: { id: string; title: string; device: string; severity: string }[];
  saved: boolean;
};

export type Change = {
  id: string; scopeId: string; environment: Environment; status: ChangeStatus;
  title: string; intent: string; source: "user" | "assistant" | "ztp";
  plan: Plan; snapshot: Record<string, string> | null; result: ChangeResult | null;
  approvedAt: string | null; approvedBy: string | null; createdAt: string; updatedAt: string;
  scheduledFor: string | null; createdBy: string | null;
};

type Row = {
  id: string; scope_id: string; environment: Environment; status: ChangeStatus; title: string; intent: string; source: Change["source"];
  plan_json: string; snapshot_json: string | null; result_json: string | null; approved_at: string | null; approved_by: string | null; created_at: string; updated_at: string;
  scheduled_for: string | null; created_by: string | null;
};

const fromRow = (r: Row): Change => ({
  id: r.id, scopeId: r.scope_id, environment: r.environment, status: r.status, title: r.title, intent: r.intent, source: r.source,
  plan: JSON.parse(r.plan_json) as Plan, snapshot: r.snapshot_json ? (JSON.parse(r.snapshot_json) as Record<string, string>) : null,
  result: r.result_json ? (JSON.parse(r.result_json) as ChangeResult) : null,
  approvedAt: r.approved_at, approvedBy: r.approved_by, createdAt: r.created_at, updatedAt: r.updated_at,
  scheduledFor: r.scheduled_for ?? null, createdBy: r.created_by ?? null,
});

export function createChange(db: Db, c: { scopeId: string; environment: Environment; title: string; intent: string; source: Change["source"]; plan: Plan; createdBy?: string | null }): Change {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO changes (id, scope_id, environment, status, title, intent, source, plan_json, created_at, updated_at, created_by) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, c.scopeId, c.environment, c.title, c.intent, c.source, JSON.stringify(c.plan), now, now, c.createdBy ?? null);
  const made = getChange(db, id)!;
  emitEvent(db, "change.proposed", changeEvent(made));
  return made;
}

/** What a receiver is told about a change: enough to find it and act, never the configuration lines. */
const changeEvent = (c: Change) => ({ changeId: c.id, title: c.title, scopeId: c.scopeId, environment: c.environment, status: c.status, source: c.source, createdBy: c.createdBy, devices: c.plan.devices.map((d) => d.label) });

export function getChange(db: Db, id: string): Change | null {
  const r = db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function listChanges(db: Db, scopeId: string, limit = 50): Change[] {
  return (db.prepare("SELECT * FROM changes WHERE scope_id = ? ORDER BY created_at DESC LIMIT ?").all(scopeId, limit) as Row[]).map(fromRow);
}

export function updateChange(db: Db, id: string, patch: Partial<Pick<Change, "status" | "snapshot" | "result" | "approvedAt" | "approvedBy" | "scheduledFor">>): Change {
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | null)[] = [new Date().toISOString()];
  if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
  if (patch.snapshot !== undefined) { sets.push("snapshot_json = ?"); vals.push(patch.snapshot ? JSON.stringify(patch.snapshot) : null); }
  if (patch.result !== undefined) { sets.push("result_json = ?"); vals.push(patch.result ? JSON.stringify(patch.result) : null); }
  if (patch.approvedAt !== undefined) { sets.push("approved_at = ?"); vals.push(patch.approvedAt); }
  if (patch.approvedBy !== undefined) { sets.push("approved_by = ?"); vals.push(patch.approvedBy); }
  if (patch.scheduledFor !== undefined) { sets.push("scheduled_for = ?"); vals.push(patch.scheduledFor); }
  const before = patch.status !== undefined ? getChange(db, id)?.status : undefined;
  db.prepare(`UPDATE changes SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  const after = getChange(db, id)!;
  if (patch.status !== undefined && before !== patch.status) emitEvent(db, `change.${patch.status}` as never, changeEvent(after));
  return after;
}

/** A change left deploying or rolling back by a crash cannot still be running; say so instead of showing it as live. */
export function failInterrupted(db: Db): number {
  const now = new Date().toISOString();
  return Number(db.prepare("UPDATE changes SET status = 'failed', updated_at = ? WHERE status IN ('deploying', 'rolling_back')").run(now).changes);
}

/** Approved changes whose scheduled time has come. */
export function dueScheduled(db: Db, now: Date): Change[] {
  return (db.prepare("SELECT * FROM changes WHERE status = 'approved' AND scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY scheduled_for").all(now.toISOString()) as Row[]).map(fromRow);
}

/**
 * What may be deleted from the list. A change that is queued, being applied, paused part-way or being rolled back is
 * still in flight and cannot go; a failed or half-undone one can, but only knowingly, because its snapshot goes with it.
 */
export const DELETABLE: ChangeStatus[] = ["proposed", "rejected", "rolled_back", "verified", "failed", "rollback_failed"];
/** Settled and needing nothing further: what "clear finished" removes. */
export const FINISHED: ChangeStatus[] = ["rejected", "rolled_back", "verified"];

export class NotDeletable extends Error {}

export function deleteChange(db: Db, id: string): Change {
  const c = getChange(db, id);
  if (!c) throw new NotDeletable("No such change.");
  if (!DELETABLE.includes(c.status)) throw new NotDeletable(`A change that is ${c.status.replace("_", " ")} cannot be deleted yet. Finish, roll back or reject it first.`);
  db.prepare("DELETE FROM changes WHERE id = ?").run(id);
  return c;
}

export function clearFinished(db: Db, scopeId: string): number {
  const marks = FINISHED.map(() => "?").join(",");
  return Number(db.prepare(`DELETE FROM changes WHERE scope_id = ? AND status IN (${marks})`).run(scopeId, ...FINISHED).changes);
}

/** Deletes the chosen changes that may go and reports the rest with the reason, so a mixed selection is never all-or-nothing. */
export function deleteChanges(db: Db, ids: string[]): { removed: Change[]; skipped: { id: string; title: string; reason: string }[] } {
  const removed: Change[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];
  for (const id of ids) {
    try {
      removed.push(deleteChange(db, id));
    } catch (e) {
      skipped.push({ id, title: getChange(db, id)?.title ?? id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { removed, skipped };
}
