import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authState, isExposed, setCookie, setupToken } from "@/lib/auth/access";
import { AuthError, SESSION_MAX_MS, countUsers, createSession, createUser } from "@/lib/auth/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(300), setupToken: z.string().max(200).optional() }).strict();

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Creates the first administrator and signs them in. It works once. On an install that listens beyond this machine it
 * also needs the setup token (TS_SETUP_TOKEN, or the one printed in the server log), so whoever reaches the port first
 * cannot take the app over.
 */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  if (countUsers(db) > 0) throw new HttpError(409, "Setup is already done. Sign in instead.", "already_setup");
  if (isExposed() && !(b.setupToken && same(b.setupToken, setupToken()))) throw new HttpError(403, "Enter the setup token: it is TS_SETUP_TOKEN, or the one printed in the server's log.", "bad_setup_token");
  try {
    const user = await createUser(db, { username: b.username, password: b.password, role: "admin" });
    const s = createSession(db, user.id);
    addAudit(db, { kind: "auth", actor: `user:${user.username}`, summary: `Login turned on: ${user.username} created as the first administrator` });
    const res = json({ user: { username: user.username, role: user.role }, state: authState(db) }, 201);
    res.headers.append("Set-Cookie", setCookie(req, s.token, Math.floor(SESSION_MAX_MS / 1000)));
    return res;
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { public: true, write: true });
