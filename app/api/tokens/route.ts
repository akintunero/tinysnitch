import { z } from "zod";
import { TokenError, createApiToken, listApiTokens } from "@/lib/api/tokens";
import { ROLES } from "@/lib/auth/roles";
import { addAudit } from "@/lib/database/repo";
import { currentActor } from "@/lib/security/actor";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async () => json({ tokens: listApiTokens(getContext().db) }), { role: "admin", sessionOnly: true });

const body = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(ROLES), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }).strict();

/** Makes a token. The token itself is in this answer and nowhere else: only its hash is kept. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  try {
    const made = createApiToken(db, { name: b.name, role: b.role, expiresInDays: b.expiresInDays ?? null, createdBy: currentActor()?.username ?? null });
    addAudit(db, { kind: "auth", actor: "user", summary: `Created API token "${made.record.name}" with role ${made.record.role}${made.record.expiresAt ? `, expiring ${made.record.expiresAt.slice(0, 10)}` : ""}`, data: { tokenId: made.record.id, role: made.record.role } });
    return json(made, 201);
  } catch (e) {
    if (e instanceof TokenError) throw new HttpError(400, e.message);
    throw e;
  }
}, { write: true, role: "admin", sessionOnly: true });
