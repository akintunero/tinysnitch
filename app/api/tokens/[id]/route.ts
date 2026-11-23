import { listApiTokens, revokeApiToken } from "@/lib/api/tokens";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Revokes a token at once. The record stays, marked revoked, so the history of who had access is kept. */
export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  const t = listApiTokens(db).find((x) => x.id === params.id);
  if (!t) throw new HttpError(404, "No such token.");
  if (!revokeApiToken(db, params.id)) throw new HttpError(409, "That token is already revoked.");
  addAudit(db, { kind: "auth", actor: "user", summary: `Revoked API token "${t.name}"`, data: { tokenId: t.id } });
  return json({ revoked: true });
}, { write: true, role: "admin", sessionOnly: true });
