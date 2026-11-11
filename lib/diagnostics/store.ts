import type { Db } from "../database/db";
import { redactDeep } from "../security/redact";
import type { Finding, RunSummary } from "./types";

export type StoredFinding = Finding & { firstSeen: string; lastSeen: string; runId: string };
export type StoredRun = RunSummary & { interpretation: string | null };

/**
 * Saves a run and reconciles findings with the previous one: a problem that is still there keeps its first-seen
 * time, a new one is added, and one that no longer shows up is marked cleared rather than deleted.
 */
export function saveRun(db: Db, run: RunSummary, findings: Finding[]): { opened: number; cleared: number } {
  const now = run.finishedAt;
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO diagnostic_runs (id, lab_id, started_at, finished_at, summary_json) VALUES (?, ?, ?, ?, ?)").run(run.id, run.labId, run.startedAt, run.finishedAt, JSON.stringify(run));
    const existing = new Map((db.prepare("SELECT id, status, data_json FROM findings WHERE lab_id = ?").all(run.labId) as { id: string; status: string; data_json: string }[]).map((r) => [r.id, r]));
    const upsert = db.prepare(
      "INSERT INTO findings (id, lab_id, severity, device, interface, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, device = excluded.device, interface = excluded.interface, status = 'open', data_json = excluded.data_json",
    );
    let opened = 0;
    const seen = new Set<string>();
    for (const f of findings) {
      seen.add(f.id);
      const prior = existing.get(f.id);
      const wasOpen = prior?.status === "open";
      const firstSeen = prior && wasOpen ? (JSON.parse(prior.data_json) as StoredFinding).firstSeen : now;
      if (!wasOpen) opened += 1;
      const stored: StoredFinding = { ...(redactDeep(f) as Finding), firstSeen, lastSeen: now, runId: run.id };
      upsert.run(f.id, run.labId, f.severity, f.device, f.interface, JSON.stringify(stored), firstSeen);
    }
    let cleared = 0;
    for (const [id, r] of existing) {
      if (r.status === "open" && !seen.has(id)) {
        db.prepare("UPDATE findings SET status = 'cleared' WHERE id = ?").run(id);
        cleared += 1;
      }
    }
    db.exec("COMMIT");
    return { opened, cleared };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function latestRun(db: Db, labId: string): StoredRun | null {
  const r = db.prepare("SELECT summary_json, interpretation FROM diagnostic_runs WHERE lab_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(labId) as { summary_json: string; interpretation: string | null } | undefined;
  return r ? { ...(JSON.parse(r.summary_json) as RunSummary), interpretation: r.interpretation } : null;
}

export function openFindings(db: Db, labId: string): StoredFinding[] {
  const rows = db.prepare("SELECT data_json FROM findings WHERE lab_id = ? AND status = 'open'").all(labId) as { data_json: string }[];
  const order = { critical: 0, warning: 1, info: 2 } as const;
  return rows.map((r) => JSON.parse(r.data_json) as StoredFinding).sort((a, b) => order[a.severity] - order[b.severity] || a.device.localeCompare(b.device) || a.title.localeCompare(b.title));
}

export function setInterpretation(db: Db, runId: string, text: string): void {
  db.prepare("UPDATE diagnostic_runs SET interpretation = ? WHERE id = ?").run(text, runId);
}
