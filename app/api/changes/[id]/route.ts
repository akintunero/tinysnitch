import { NotDeletable, deleteChange, getChange } from "@/lib/changes/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, params) => {
  const c = getChange(getContext().db, params.id);
  if (!c) throw new HttpError(404, "No such change.");
  return json(c);
});

/** Removes one change from the list. Anything still in flight is refused. The removal is recorded. */
export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  try {
    const c = deleteChange(db, params.id);
    addAudit(db, { kind: "configuration", actor: "user", summary: `Deleted change "${c.title}" (${c.status.replace("_", " ")}, ${c.environment})`, data: { changeId: c.id, scopeId: c.scopeId, status: c.status } });
    return json({ deleted: true });
  } catch (e) {
    if (e instanceof NotDeletable) throw new HttpError(e.message === "No such change." ? 404 : 409, e.message);
    throw e;
  }
}, { write: true, role: "approver" });
