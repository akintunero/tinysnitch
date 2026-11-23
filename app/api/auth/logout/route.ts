import { clearCookie, tokenOf } from "@/lib/auth/access";
import { endSession } from "@/lib/auth/store";
import { addAudit } from "@/lib/database/repo";
import { currentActor } from "@/lib/security/actor";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { db } = getContext();
  const t = tokenOf(req);
  if (t) endSession(db, t);
  const a = currentActor();
  if (a) addAudit(db, { kind: "auth", actor: `user:${a.username}`, summary: `${a.username} signed out` });
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearCookie(req));
  return res;
}, { public: true, write: true });
