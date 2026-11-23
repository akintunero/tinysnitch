/**
 * Closing the loop from a finding to a fix.
 *
 * A few findings have exactly one correct answer (a BGP neighbour set to the wrong AS, SSH not pinned to version 2). For those
 * the check states the lines that would clear it. This turns them into an ordinary change: proposed, never applied, so a
 * person still reads and approves it, and the usual snapshot, verification and rollback apply. When the change is verified the
 * post-change diagnostics run clears the finding; if it does not clear, the finding is still there to say so.
 */
import { ChangeError, proposeChange } from "../changes/engine";
import { type Change, getChange } from "../changes/store";
import type { Db } from "../database/db";
import { addAudit } from "../database/repo";
import { currentActor } from "../security/actor";
import { getContext } from "../server/context";
import type { Fix } from "./types";
import type { StoredFinding } from "./store";

export class FixError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const OPEN: Change["status"][] = ["proposed", "approved", "deploying", "paused", "rolling_back"];

export type FixChange = { changeId: string; status: Change["status"] | "removed"; title: string | null; createdAt: string };

/** The changes filed for each finding of a network, newest first. */
export function fixChangesFor(db: Db, scopeId: string): Record<string, FixChange[]> {
  const rows = db.prepare("SELECT finding_id, change_id, created_at FROM finding_fixes WHERE scope_id = ? ORDER BY created_at DESC, rowid DESC").all(scopeId) as { finding_id: string; change_id: string; created_at: string }[];
  const out: Record<string, FixChange[]> = {};
  for (const r of rows) {
    const c = getChange(db, r.change_id);
    (out[r.finding_id] ??= []).push({ changeId: r.change_id, status: c?.status ?? "removed", title: c?.title ?? null, createdAt: r.created_at });
  }
  return out;
}

function stored(db: Db, id: string): { scopeId: string; open: boolean; finding: StoredFinding } | null {
  const r = db.prepare("SELECT lab_id, status, data_json FROM findings WHERE id = ?").get(id) as { lab_id: string; status: string; data_json: string } | undefined;
  return r ? { scopeId: r.lab_id, open: r.status === "open", finding: JSON.parse(r.data_json) as StoredFinding } : null;
}

/** Files the finding's fix as a change. Nothing is sent to any device. */
export async function proposeFix(findingId: string): Promise<{ change: Change; fix: Fix; finding: { id: string; title: string; device: string } }> {
  const { db } = getContext();
  const s = stored(db, findingId);
  if (!s) throw new FixError("No such finding.", 404);
  const { finding } = s;
  if (!s.open) throw new FixError("This finding has cleared, so there is nothing to fix.", 409);
  if (!finding.fix) throw new FixError("This finding has no fix Tiny Snitch can state with certainty. Read its recommended action and write the change yourself.", 409);
  const existing = (fixChangesFor(db, s.scopeId)[findingId] ?? []).find((c) => c.status !== "removed" && OPEN.includes(c.status as Change["status"]));
  if (existing) throw new FixError("A fix for this finding is already open. Review it on the Configurations page, or reject it first.", 409);
  let change: Change;
  try {
    change = await proposeChange({
      scopeId: s.scopeId,
      title: `Fix: ${finding.title}`.slice(0, 120),
      intent: `From a diagnostics finding (${finding.kind}) on ${finding.device}: ${finding.title}. ${finding.fix.note ?? ""}`.trim(),
      source: "user",
      devices: [{ device: finding.device, commands: finding.fix.commands }],
    });
  } catch (e) {
    if (e instanceof ChangeError) throw new FixError(e.message, e.status);
    throw e;
  }
  db.prepare("INSERT INTO finding_fixes (finding_id, scope_id, change_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)").run(findingId, s.scopeId, change.id, new Date().toISOString(), currentActor()?.username ?? null);
  addAudit(db, { kind: "configuration", actor: "user", summary: `Filed a fix for finding "${finding.title}" on ${finding.device}`, data: { findingId, changeId: change.id } });
  return { change, fix: finding.fix, finding: { id: findingId, title: finding.title, device: finding.device } };
}
