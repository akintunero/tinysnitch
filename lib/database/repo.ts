import { redactDeep, redactSecrets } from "../security/redact";
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, settingsSchema } from "../settings";
import type { Db } from "./db";

export function getSettings(db: Db): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value);
    } catch {
      /* a corrupt value falls back to its default */
    }
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function saveSettings(db: Db, patch: SettingsPatch): Settings {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v), now);
  return getSettings(db);
}

export type Position = { x: number; y: number };

export function getPositions(db: Db, labId: string): Record<string, Position> {
  const rows = db.prepare("SELECT node_id, x, y FROM node_positions WHERE lab_id = ?").all(labId) as { node_id: string; x: number; y: number }[];
  return Object.fromEntries(rows.map((r) => [r.node_id, { x: r.x, y: r.y }]));
}

export function savePositions(db: Db, labId: string, positions: Record<string, Position>): void {
  const stmt = db.prepare(
    "INSERT INTO node_positions (lab_id, node_id, x, y) VALUES (?, ?, ?, ?) ON CONFLICT(lab_id, node_id) DO UPDATE SET x = excluded.x, y = excluded.y",
  );
  for (const [nodeId, p] of Object.entries(positions)) stmt.run(labId, nodeId, p.x, p.y);
}

export function clearPositions(db: Db, labId: string): void {
  db.prepare("DELETE FROM node_positions WHERE lab_id = ?").run(labId);
}

/** SSH host keys, remembered on first contact. The transport refuses a device whose key later differs. */
export function hostKeyStore(db: Db) {
  return {
    get(id: string): string | null {
      return (db.prepare("SELECT fingerprint FROM known_hosts WHERE id = ?").get(id) as { fingerprint: string } | undefined)?.fingerprint ?? null;
    },
    set(id: string, fingerprint: string): void {
      db.prepare("INSERT OR IGNORE INTO known_hosts (id, fingerprint, first_seen) VALUES (?, ?, ?)").run(id, fingerprint, new Date().toISOString());
    },
    forget(id: string): void {
      db.prepare("DELETE FROM known_hosts WHERE id = ?").run(id);
    },
  };
}

export type AuditKind =
  | "settings" | "mcp" | "tool_call" | "claude" | "lab" | "request" | "diagnostic" | "configuration" | "approval" | "error";

export type AuditEvent = { id: number; at: string; kind: AuditKind; actor: string; summary: string; data: unknown };

/** Summaries and data are scrubbed of credentials before they are written. */
export function addAudit(db: Db, e: { kind: AuditKind; summary: string; actor?: string; data?: unknown }): void {
  const data = e.data === undefined ? null : JSON.stringify(redactDeep(e.data));
  db.prepare("INSERT INTO audit_events (at, kind, actor, summary, data_json) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(), e.kind, e.actor ?? "system", redactSecrets(e.summary).slice(0, 500), data,
  );
}

export function listAudit(db: Db, limit = 200): AuditEvent[] {
  const rows = db.prepare("SELECT id, at, kind, actor, summary, data_json FROM audit_events ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number; at: string; kind: AuditKind; actor: string; summary: string; data_json: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, actor: r.actor, summary: r.summary, data: r.data_json ? JSON.parse(r.data_json) : null }));
}
