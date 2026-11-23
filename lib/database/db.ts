/**
 * SQLite through Node's built-in node:sqlite (no native add-on to compile). Loaded with
 * process.getBuiltinModule so the bundler never tries to resolve it.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE conversations (id TEXT PRIMARY KEY, lab_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE deployments (
    id TEXT PRIMARY KEY, lab_id TEXT, status TEXT NOT NULL,
    plan_json TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE findings (
    id TEXT PRIMARY KEY, lab_id TEXT, severity TEXT NOT NULL, device TEXT, interface TEXT,
    status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
    actor TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT
  );
  CREATE INDEX audit_at ON audit_events(at);
  CREATE TABLE node_positions (
    lab_id TEXT NOT NULL, node_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
    PRIMARY KEY (lab_id, node_id)
  );
  `,
  `
  CREATE TABLE diagnostic_runs (
    id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
    summary_json TEXT NOT NULL, interpretation TEXT
  );
  CREATE INDEX diagnostic_runs_lab ON diagnostic_runs(lab_id, started_at);
  CREATE INDEX findings_lab ON findings(lab_id, status);
  `,
  `
  -- SSH host keys seen for devices reached directly. A changed key is refused, not replaced.
  CREATE TABLE known_hosts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, first_seen TEXT NOT NULL);
  -- A proposed configuration change and everything that happened to it. plan_json holds the commands per device,
  -- snapshot_json the configuration captured before it was applied (what rollback restores), result_json the outcome.
  CREATE TABLE changes (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL,
    title TEXT NOT NULL, intent TEXT NOT NULL, source TEXT NOT NULL,
    plan_json TEXT NOT NULL, snapshot_json TEXT, result_json TEXT,
    approved_at TEXT, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX changes_scope ON changes(scope_id, created_at);
  -- The last discovery crawl per scope, so a crawl is not repeated on every page load.
  CREATE TABLE discovery_results (scope_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  -- Running configurations, one row per distinct version of a device (consecutive identical reads are not stored twice).
  -- config holds device output that was already masked for secrets. source: scheduled, manual, pre-change:<id>, change:<id>, rollback:<id>.
  CREATE TABLE config_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL, device TEXT NOT NULL, taken_at TEXT NOT NULL,
    sha256 TEXT NOT NULL, source TEXT NOT NULL, config TEXT NOT NULL
  );
  CREATE INDEX config_backups_device ON config_backups(scope_id, device, id);
  -- A device whose configuration changed between two reads when no Tiny Snitch change explains it.
  CREATE TABLE drift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL, device TEXT NOT NULL, detected_at TEXT NOT NULL,
    from_backup INTEGER NOT NULL, to_backup INTEGER NOT NULL, lines_added INTEGER NOT NULL, lines_removed INTEGER NOT NULL,
    possible_change TEXT, acknowledged_at TEXT, acknowledged_by TEXT
  );
  CREATE INDEX drift_scope ON drift_events(scope_id, detected_at);
  -- When a scheduled job last ran, per network, so a restart does not repeat it at once.
  CREATE TABLE job_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  -- A change approved by a person can be set to run later, inside a maintenance window.
  ALTER TABLE changes ADD COLUMN scheduled_for TEXT;
  -- Who proposed it, so a second person can be required to approve it.
  ALTER TABLE changes ADD COLUMN created_by TEXT;
  `,
  `
  -- People who can sign in. Only a salted scrypt hash of the password is kept.
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT
  );
  -- Only the SHA-256 of a session token is kept, so a copy of the database cannot be used to sign in.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  `,
  `
  -- API access for other systems. Only the SHA-256 of a token is kept; the token itself is shown once, when it is made.
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, role TEXT NOT NULL,
    created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT
  );
  -- Where events are sent. The signing secret has to be kept to sign each delivery; it is shown once, when the hook is made.
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL
  );
  -- One row per event per hook, retried with a growing delay until it is delivered or the attempts run out.
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
    last_status INTEGER, last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
  CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
  -- A repeated POST with the same Idempotency-Key gets the first answer back instead of making a second change.
  CREATE TABLE idempotency_keys (
    scope TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (scope, key)
  );
  `,
  `
  -- A service someone provisioned from the catalogue, remembered as a thing of its own: what it is, where it is, whether it is
  -- really in place. values_json/devices_json are what is wanted; applied_* are what the last verified change left on the devices.
  -- status: pending (a change is open), active, failed (a change failed and the devices need a look), inactive (never applied), retired.
  CREATE TABLE service_instances (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, service_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    values_json TEXT NOT NULL, devices_json TEXT NOT NULL, applied_values_json TEXT, applied_devices_json TEXT,
    pending_change_id TEXT, pending_op TEXT, touches_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT
  );
  CREATE INDEX service_instances_scope ON service_instances(scope_id, status);
  -- Every change that was filed for a service, so its whole story can be read back.
  CREATE TABLE service_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL, op TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX service_history_service ON service_history(service_id, id);
  `,
  `
  -- A change filed to fix a finding, so the finding can show where its fix stands and a second fix is not filed on top of an open one.
  CREATE TABLE finding_fixes (
    finding_id TEXT NOT NULL, scope_id TEXT NOT NULL, change_id TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
    PRIMARY KEY (finding_id, change_id)
  );
  CREATE INDEX finding_fixes_scope ON finding_fixes(scope_id, created_at);
  `,
];

export function resolveDatabasePath(url: string | undefined, cwd = process.cwd()): string {
  const raw = (url ?? "file:./data/tiny-snitch.db").trim();
  if (raw === ":memory:" || raw === "file::memory:") return ":memory:";
  if (!raw.startsWith("file:")) throw new Error("DATABASE_URL must look like file:./data/tiny-snitch.db");
  return resolve(cwd, raw.slice("file:".length));
}

export function openDatabase(url: string | undefined = process.env.DATABASE_URL): Db {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const path = resolveDatabasePath(url);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
