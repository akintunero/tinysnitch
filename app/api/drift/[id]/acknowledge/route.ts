import { acknowledgeDrift } from "@/lib/backup/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = route(async (_req, params) => {
  const { db } = getContext();
  const id = /^\d{1,12}$/.test(params.id) ? Number(params.id) : null;
  const d = id === null ? null : acknowledgeDrift(db, id, "user");
  if (!d) throw new HttpError(404, "No such drift event.");
  addAudit(db, { kind: "backup", actor: "user", summary: `Acknowledged drift on ${d.device}`, data: { driftId: d.id } });
  return json(d);
}, { write: true });
