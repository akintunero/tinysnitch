import { z } from "zod";
import { tokenOf } from "@/lib/auth/access";
import { AuthError, checkLogin, getUserByName, setPassword } from "@/lib/auth/store";
import { lockedFor, recordFailure, recordSuccess } from "@/lib/auth/throttle";
import { addAudit } from "@/lib/database/repo";
import { currentActor } from "@/lib/security/actor";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ current: z.string().min(1).max(300), next: z.string().min(1).max(300) }).strict();

/** A person changes their own password. Every other session of theirs is signed out. */
export const POST = route(async (req) => {
  const { current, next } = await readJson(req, body);
  const { db } = getContext();
  const a = currentActor();
  if (!a) throw new HttpError(409, "Login is not turned on, so there is no password to change.");
  if (lockedFor(a.username) > 0) throw new HttpError(429, "Too many failed attempts. Try again later.", "locked");
  if (!(await checkLogin(db, a.username, current))) { recordFailure(a.username); throw new HttpError(403, "The current password is wrong.", "bad_password"); }
  recordSuccess(a.username);
  try {
    await setPassword(db, getUserByName(db, a.username)!.id, next, tokenOf(req) ?? undefined);
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(e.status, e.message);
    throw e;
  }
  addAudit(db, { kind: "auth", actor: `user:${a.username}`, summary: `${a.username} changed their password` });
  return json({ ok: true });
}, { write: true, role: "viewer", sessionOnly: true });
