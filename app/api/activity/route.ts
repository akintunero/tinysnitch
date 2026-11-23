import { addAudit, clearActivity, countBackgroundReads, listAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Newest first. Background reads (page loads and polling) are left out unless `reads=1`, so they cannot crowd out real
 * events; `hiddenReads` says how many are held back, so nothing is hidden silently.
 */
export const GET = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const raw = Number(q.get("limit") ?? 200);
  const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 500) : 200;
  const { db } = getContext();
  const reads = q.get("reads") === "1";
  return json({ events: listAudit(db, limit, { reads }), hiddenReads: reads ? 0 : countBackgroundReads(db) });
});

/**
 * Trims the log: `?mode=reads` drops background reads, `?mode=older&days=N` drops entries older than N days (7 to 3650).
 * There is deliberately no way to wipe everything. Administrators only, and the trim is itself recorded.
 */
export const DELETE = route(async (req) => {
  const q = new URL(req.url).searchParams;
  const { db } = getContext();
  const mode = q.get("mode");
  let removed: number;
  let what: string;
  if (mode === "reads") {
    removed = clearActivity(db, { reads: true });
    what = "background reads";
  } else if (mode === "older") {
    const days = Number(q.get("days"));
    if (!Number.isInteger(days) || days < 7 || days > 3650) throw new HttpError(400, "days must be a whole number from 7 to 3650.");
    removed = clearActivity(db, { olderThanDays: days });
    what = `entries older than ${days} days`;
  } else {
    throw new HttpError(400, "mode must be reads or older.");
  }
  addAudit(db, { kind: "settings", actor: "user", summary: `Cleared ${removed} activity entr${removed === 1 ? "y" : "ies"}: ${what}`, data: { mode, removed } });
  return json({ removed });
}, { write: true, role: "admin" });
