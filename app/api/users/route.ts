import { z } from "zod";
import { ROLES } from "@/lib/auth/roles";
import { AuthError, createUser, listUsers } from "@/lib/auth/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async () => json({ users: listUsers(getContext().db) }), { role: "admin", sessionOnly: true });

const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(300), role: z.enum(ROLES) }).strict();

export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  try {
    const u = await createUser(db, b);
    addAudit(db, { kind: "auth", actor: "user", summary: `Created user ${u.username} (${u.role})` });
    return json(u, 201);
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true, role: "admin", sessionOnly: true });
