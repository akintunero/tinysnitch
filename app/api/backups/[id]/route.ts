import { lineDiff } from "@/lib/backup/diff";
import { canonicalConfig, deleteBackup, getBackup, listVersions, previousBackup } from "@/lib/backup/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const num = (s: string | null) => (s !== null && /^\d{1,12}$/.test(s) ? Number(s) : null);

/** One stored version, with a diff against the version before it (or against ?against=<id>). */
export const GET = route(async (req, params) => {
  const { db } = getContext();
  const id = num(params.id);
  const b = id === null ? null : getBackup(db, id);
  if (!b) throw new HttpError(404, "No such backup.");
  const againstId = num(new URL(req.url).searchParams.get("against"));
  const other = againstId !== null ? getBackup(db, againstId) : previousBackup(db, b);
  if (againstId !== null && (!other || other.scopeId !== b.scopeId || other.device !== b.device)) throw new HttpError(400, "That version belongs to a different device.");
  // Compared the way drift is detected: without the timestamps, comments and separators a device rewrites by itself.
  const diff = other ? lineDiff(canonicalConfig(other.config), canonicalConfig(b.config)) : null;
  return json({ backup: b, against: other ? { id: other.id, takenAt: other.takenAt, source: other.source } : null, diff, versions: listVersions(db, b.scopeId, b.device) });
});

/** Deletes one stored version (never the newest of a device) and the drift events that point at it. */
export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  const id = num(params.id);
  if (id === null) throw new HttpError(400, "That is not a backup id.");
  const r = deleteBackup(db, id);
  if (!r.ok) throw new HttpError(r.reason === "No such backup." ? 404 : 409, r.reason);
  addAudit(db, { kind: "backup", actor: "user", summary: `Deleted a stored version of ${r.backup.device} (${r.backup.source}, ${r.backup.takenAt})`, data: { backupId: id, scopeId: r.backup.scopeId, device: r.backup.device } });
  return json({ deleted: true });
}, { write: true, role: "approver" });
