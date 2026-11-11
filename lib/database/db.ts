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
