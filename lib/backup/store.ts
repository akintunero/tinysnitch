import { createHash } from "node:crypto";
import { emitEvent } from "../api/webhooks";
import { VOLATILE } from "../changes/config-diff";
import type { Db } from "../database/db";
import { redactSecrets } from "../security/redact";
import { diffOps } from "./diff";

/** Versions kept per device. Older ones are dropped so the database does not grow without limit. */
export const KEEP_VERSIONS = 100;

export type BackupMeta = { id: number; scopeId: string; device: string; takenAt: string; sha256: string; source: string; bytes: number };
export type Backup = BackupMeta & { config: string };
export type DriftEvent = {
  id: number; scopeId: string; device: string; detectedAt: string; fromBackup: number; toBackup: number;
  linesAdded: number; linesRemoved: number; possibleChange: string | null; acknowledgedAt: string | null; acknowledgedBy: string | null;
};

/**
 * What is compared between two reads: the configuration without the lines a device rewrites on its own (timestamps,
 * byte counts, "last change" comments) and without trailing space. Two reads that differ only there are the same.
 */
export function canonicalConfig(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !(VOLATILE.test(l.trim()) && !/^\s/.test(l)))
    .join("\n");
}

export const hashConfig = (text: string) => createHash("sha256").update(canonicalConfig(text)).digest("hex");

/** Sources that are a Tiny Snitch change and therefore explain a difference; every other source can reveal drift. */
const explains = (source: string) => /^(change|rollback):/.test(source);

const metaOf = (r: Record<string, unknown>): BackupMeta => ({ id: Number(r.id), scopeId: String(r.scope_id), device: String(r.device), takenAt: String(r.taken_at), sha256: String(r.sha256), source: String(r.source), bytes: Number(r.bytes ?? 0) });
const META_COLS = "id, scope_id, device, taken_at, sha256, source, length(config) AS bytes";

export function latestBackup(db: Db, scopeId: string, device: string): Backup | null {
  const r = db.prepare("SELECT *, length(config) AS bytes FROM config_backups WHERE scope_id = ? AND device = ? ORDER BY id DESC LIMIT 1").get(scopeId, device) as Record<string, unknown> | undefined;
  return r ? { ...metaOf(r), config: String(r.config) } : null;
}

export function getBackup(db: Db, id: number): Backup | null {
  const r = db.prepare("SELECT *, length(config) AS bytes FROM config_backups WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? { ...metaOf(r), config: String(r.config) } : null;
}

export function previousBackup(db: Db, b: BackupMeta): Backup | null {
  const r = db.prepare("SELECT *, length(config) AS bytes FROM config_backups WHERE scope_id = ? AND device = ? AND id < ? ORDER BY id DESC LIMIT 1").get(b.scopeId, b.device, b.id) as Record<string, unknown> | undefined;
  return r ? { ...metaOf(r), config: String(r.config) } : null;
}

export function listVersions(db: Db, scopeId: string, device: string, limit = 50): BackupMeta[] {
  return (db.prepare(`SELECT ${META_COLS} FROM config_backups WHERE scope_id = ? AND device = ? ORDER BY id DESC LIMIT ?`).all(scopeId, device, limit) as Record<string, unknown>[]).map(metaOf);
}

export function devicesWithBackups(db: Db, scopeId: string): { device: string; latest: BackupMeta; versions: number }[] {
  const rows = db.prepare("SELECT device, COUNT(*) AS n, MAX(id) AS last FROM config_backups WHERE scope_id = ? GROUP BY device ORDER BY device").all(scopeId) as { device: string; n: number; last: number }[];
  return rows.map((r) => ({ device: r.device, versions: r.n, latest: metaOf(db.prepare(`SELECT ${META_COLS} FROM config_backups WHERE id = ?`).get(r.last) as Record<string, unknown>) }));
}

export type RecordResult = { backup: BackupMeta; changed: boolean; drift: DriftEvent | null };

/**
 * Stores a configuration as the newest version of a device unless it is identical to the newest one already stored.
 * If it differs and the source is not a Tiny Snitch change, that is drift: a drift event records how much changed and
 * whether a change that failed or never finished was touching the device at the time.
 */
export function recordBackup(db: Db, input: { scopeId: string; device: string; config: string; source: string; now?: Date }): RecordResult {
  const config = redactSecrets(input.config);
  const sha = hashConfig(config);
  const prev = latestBackup(db, input.scopeId, input.device);
  if (prev && prev.sha256 === sha) return { backup: prev, changed: false, drift: null };

  const takenAt = (input.now ?? new Date()).toISOString();
  const res = db.prepare("INSERT INTO config_backups (scope_id, device, taken_at, sha256, source, config) VALUES (?, ?, ?, ?, ?, ?)").run(input.scopeId, input.device, takenAt, sha, input.source, config);
  const id = Number(res.lastInsertRowid);
  const backup: BackupMeta = { id, scopeId: input.scopeId, device: input.device, takenAt, sha256: sha, source: input.source, bytes: Buffer.byteLength(config) };

  let drift: DriftEvent | null = null;
  if (prev && !explains(input.source)) {
    const ops = diffOps(canonicalConfig(prev.config).split("\n"), canonicalConfig(config).split("\n"));
    const added = ops.filter((o) => o.op === "+").length, removed = ops.filter((o) => o.op === "-").length;
    // A change that failed or is unfinished may have left this device half-applied; say so rather than call it out-of-band.
    const maybe = db.prepare("SELECT id FROM changes WHERE scope_id = ? AND status IN ('failed', 'rollback_failed', 'deploying', 'rolling_back') AND updated_at > ? AND plan_json LIKE ? ORDER BY updated_at DESC LIMIT 1")
      .get(input.scopeId, prev.takenAt, `%${JSON.stringify(input.device).slice(1, -1)}%`) as { id: string } | undefined;
    const d = db.prepare("INSERT INTO drift_events (scope_id, device, detected_at, from_backup, to_backup, lines_added, lines_removed, possible_change) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.scopeId, input.device, takenAt, prev.id, id, added, removed, maybe?.id ?? null);
    drift = { id: Number(d.lastInsertRowid), scopeId: input.scopeId, device: input.device, detectedAt: takenAt, fromBackup: prev.id, toBackup: id, linesAdded: added, linesRemoved: removed, possibleChange: maybe?.id ?? null, acknowledgedAt: null, acknowledgedBy: null };
  }

  if (drift) emitEvent(db, "drift.detected", { scopeId: drift.scopeId, device: drift.device, linesAdded: drift.linesAdded, linesRemoved: drift.linesRemoved, possibleChange: drift.possibleChange, detectedAt: drift.detectedAt });

  // Retention. Drift events keep pointing at versions that are still stored, because only the oldest are dropped.
  db.prepare("DELETE FROM config_backups WHERE scope_id = ? AND device = ? AND id NOT IN (SELECT id FROM config_backups WHERE scope_id = ? AND device = ? ORDER BY id DESC LIMIT ?)")
    .run(input.scopeId, input.device, input.scopeId, input.device, KEEP_VERSIONS);
  return { backup, changed: true, drift };
}

const driftOf = (r: Record<string, unknown>): DriftEvent => ({
  id: Number(r.id), scopeId: String(r.scope_id), device: String(r.device), detectedAt: String(r.detected_at), fromBackup: Number(r.from_backup), toBackup: Number(r.to_backup),
  linesAdded: Number(r.lines_added), linesRemoved: Number(r.lines_removed), possibleChange: (r.possible_change as string | null) ?? null, acknowledgedAt: (r.acknowledged_at as string | null) ?? null, acknowledgedBy: (r.acknowledged_by as string | null) ?? null,
});

export function listDrift(db: Db, scopeId: string, opts: { includeAcknowledged?: boolean; limit?: number } = {}): DriftEvent[] {
  const where = opts.includeAcknowledged ? "" : "AND acknowledged_at IS NULL";
  return (db.prepare(`SELECT * FROM drift_events WHERE scope_id = ? ${where} ORDER BY id DESC LIMIT ?`).all(scopeId, opts.limit ?? 100) as Record<string, unknown>[]).map(driftOf);
}

export function acknowledgeDrift(db: Db, id: number, by: string): DriftEvent | null {
  db.prepare("UPDATE drift_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL").run(new Date().toISOString(), by, id);
  const r = db.prepare("SELECT * FROM drift_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? driftOf(r) : null;
}

// ---- when scheduled jobs last ran -----------------------------------------------------------------------------
export function jobLastRun(db: Db, key: string): number | null {
  const r = db.prepare("SELECT value FROM job_state WHERE key = ?").get(key) as { value: string } | undefined;
  const t = r ? Date.parse(r.value) : NaN;
  return Number.isFinite(t) ? t : null;
}

export function markJobRun(db: Db, key: string, at = new Date()): void {
  db.prepare("INSERT INTO job_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, at.toISOString());
}

/**
 * Removes one stored version, and the drift events that point at it. The newest version of a device stays: it is the
 * baseline the next read is compared with, so without it every difference would look like new drift.
 */
export function deleteBackup(db: Db, id: number): { ok: true; backup: BackupMeta } | { ok: false; reason: string } {
  const b = getBackup(db, id);
  if (!b) return { ok: false, reason: "No such backup." };
  const latest = latestBackup(db, b.scopeId, b.device);
  if (latest && latest.id === b.id) return { ok: false, reason: "This is the newest version of the device. It is the baseline for drift detection, so it stays." };
  db.prepare("DELETE FROM drift_events WHERE from_backup = ? OR to_backup = ?").run(id, id);
  db.prepare("DELETE FROM config_backups WHERE id = ?").run(id);
  const { config: _config, ...meta } = b;
  return { ok: true, backup: meta };
}
