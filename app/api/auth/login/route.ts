import { z } from "zod";
import { authState, setCookie } from "@/lib/auth/access";
import { SESSION_MAX_MS, checkLogin, createSession } from "@/lib/auth/store";
import { lockedFor, recordFailure, recordSuccess } from "@/lib/auth/throttle";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(300) }).strict();

export const POST = route(async (req) => {
  const { username, password } = await readJson(req, body);
  const { db } = getContext();
  if (!authState(db).enabled) throw new HttpError(409, "Login is not set up yet: there are no users.", "no_login");
  const wait = lockedFor(username);
  if (wait > 0) throw new HttpError(429, `Too many failed sign-ins. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}.`, "locked");
  const user = await checkLogin(db, username, password);
  if (!user) {
    recordFailure(username);
    addAudit(db, { kind: "auth", actor: "anonymous", summary: `Failed sign-in for "${username.slice(0, 40).replace(/[^\w.-]/g, "?")}"` });
    throw new HttpError(401, "Wrong username or password.", "bad_login"); // the same answer for a wrong name, a wrong password and a disabled account
  }
  recordSuccess(username);
  const s = createSession(db, user.id);
  addAudit(db, { kind: "auth", actor: `user:${user.username}`, summary: `${user.username} signed in` });
  const res = json({ user: { username: user.username, role: user.role } });
  res.headers.append("Set-Cookie", setCookie(req, s.token, Math.floor(SESSION_MAX_MS / 1000)));
  return res;
}, { public: true, write: true });
