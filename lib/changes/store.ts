import { randomUUID } from "node:crypto";
import type { Environment, Platform } from "../core/types";
import type { LineAssessment } from "../core/safety";
import type { Db } from "../database/db";

export type ChangeStatus =
  | "proposed" | "approved" | "deploying" | "verified" | "failed" | "rolling_back" | "rolled_back" | "rollback_failed" | "rejected";

export type DevicePlan = { deviceId: string; label: string; platform: Platform; commands: string[]; risks: LineAssessment[] };
export type Plan = { devices: DevicePlan[]; warnings: string[] };

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
};

type Row = {
  id: string; scope_id: string; environment: Environment; status: ChangeStatus; title: string; intent: string; source: Change["source"];
  plan_json: string; snapshot_json: string | null; result_json: string | null; approved_at: string | null; approved_by: string | null; created_at: string; updated_at: string;
};

const fromRow = (r: Row): Change => ({
  id: r.id, scopeId: r.scope_id, environment: r.environment, status: r.status, title: r.title, intent: r.intent, source: r.source,
  plan: JSON.parse(r.plan_json) as Plan, snapshot: r.snapshot_json ? (JSON.parse(r.snapshot_json) as Record<string, string>) : null,
  result: r.result_json ? (JSON.parse(r.result_json) as ChangeResult) : null,
  approvedAt: r.approved_at, approvedBy: r.approved_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createChange(db: Db, c: { scopeId: string; environment: Environment; title: string; intent: string; source: Change["source"]; plan: Plan }): Change {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO changes (id, scope_id, environment, status, title, intent, source, plan_json, created_at, updated_at) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)")
    .run(id, c.scopeId, c.environment, c.title, c.intent, c.source, JSON.stringify(c.plan), now, now);
  return getChange(db, id)!;
}

export function getChange(db: Db, id: string): Change | null {
  const r = db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function listChanges(db: Db, scopeId: string, limit = 50): Change[] {
  return (db.prepare("SELECT * FROM changes WHERE scope_id = ? ORDER BY created_at DESC LIMIT ?").all(scopeId, limit) as Row[]).map(fromRow);
}

export function updateChange(db: Db, id: string, patch: Partial<Pick<Change, "status" | "snapshot" | "result" | "approvedAt" | "approvedBy">>): Change {
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | null)[] = [new Date().toISOString()];
  if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
  if (patch.snapshot !== undefined) { sets.push("snapshot_json = ?"); vals.push(patch.snapshot ? JSON.stringify(patch.snapshot) : null); }
  if (patch.result !== undefined) { sets.push("result_json = ?"); vals.push(patch.result ? JSON.stringify(patch.result) : null); }
  if (patch.approvedAt !== undefined) { sets.push("approved_at = ?"); vals.push(patch.approvedAt); }
  if (patch.approvedBy !== undefined) { sets.push("approved_by = ?"); vals.push(patch.approvedBy); }
  db.prepare(`UPDATE changes SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getChange(db, id)!;
}

/** A change left deploying or rolling back by a crash cannot still be running; say so instead of showing it as live. */
export function failInterrupted(db: Db): number {
  const now = new Date().toISOString();
  return Number(db.prepare("UPDATE changes SET status = 'failed', updated_at = ? WHERE status IN ('deploying', 'rolling_back')").run(now).changes);
}
