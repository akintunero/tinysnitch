import { z } from "zod";
import { ROLES } from "@/lib/auth/roles";
import { AuthError, deleteUser, getUser, setPassword, updateUser } from "@/lib/auth/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional(), password: z.string().min(1).max(300).optional() }).strict();

/** An administrator changes someone's role, disables them, or sets a new password for them (which signs them out everywhere). */
export const PUT = route(async (req, params) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  const before = getUser(db, params.id);
  try {
    if (b.role !== undefined || b.disabled !== undefined) updateUser(db, params.id, { role: b.role, disabled: b.disabled });
    if (b.password !== undefined) await setPassword(db, params.id, b.password);
    const u = getUser(db, params.id);
    if (!u || !before) throw new HttpError(404, "No such user.");
    addAudit(db, { kind: "auth", actor: "user", summary: `Updated user ${u.username}: ${[b.role && `role ${before.role} to ${b.role}`, b.disabled !== undefined && (b.disabled ? "disabled" : "enabled"), b.password && "password reset"].filter(Boolean).join(", ")}` });
    return json(u);
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true, role: "admin", sessionOnly: true });

export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  const u = getUser(db, params.id);
  try {
    deleteUser(db, params.id);
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(e.status, e.message);
    throw e;
  }
  addAudit(db, { kind: "auth", actor: "user", summary: `Deleted user ${u?.username ?? params.id}` });
  return json({ ok: true });
}, { write: true, role: "admin", sessionOnly: true });
