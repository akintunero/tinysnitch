import { z } from "zod";
import { deleteWebhook, getWebhook, setWebhookEnabled } from "@/lib/api/webhooks";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const PUT = route(async (req, params) => {
  const { enabled } = await readJson(req, z.object({ enabled: z.boolean() }).strict());
  const { db } = getContext();
  const w = getWebhook(db, params.id);
  if (!w || !setWebhookEnabled(db, params.id, enabled)) throw new HttpError(404, "No such webhook.");
  addAudit(db, { kind: "auth", actor: "user", summary: `${enabled ? "Enabled" : "Disabled"} webhook "${w.name}"`, data: { webhookId: w.id } });
  return json({ enabled });
}, { write: true, role: "admin", sessionOnly: true });

export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  const w = getWebhook(db, params.id);
  if (!w || !deleteWebhook(db, params.id)) throw new HttpError(404, "No such webhook.");
  addAudit(db, { kind: "auth", actor: "user", summary: `Deleted webhook "${w.name}"`, data: { webhookId: w.id } });
  return json({ deleted: true });
}, { write: true, role: "admin", sessionOnly: true });
