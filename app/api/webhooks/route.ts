import { z } from "zod";
import { EVENTS, WebhookError, createWebhook, listDeliveries, listWebhooks } from "@/lib/api/webhooks";
import { addAudit } from "@/lib/database/repo";
import { currentActor } from "@/lib/security/actor";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The hooks, each with how its latest delivery went. The signing secret is never listed. */
export const GET = route(async () => {
  const { db } = getContext();
  return json({ events: EVENTS, webhooks: listWebhooks(db).map((w) => ({ ...w, lastDelivery: listDeliveries(db, w.id, 1)[0] ?? null })) });
}, { role: "admin", sessionOnly: true });

const body = z.object({ name: z.string().trim().min(1).max(80), url: z.string().max(500), events: z.array(z.string().max(60)).min(1).max(30) }).strict();

/** Makes a hook. Its signing secret is in this answer and shown once. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  try {
    const made = createWebhook(db, { ...b, createdBy: currentActor()?.username ?? null });
    addAudit(db, { kind: "auth", actor: "user", summary: `Created webhook "${made.webhook.name}" for ${made.webhook.events.join(", ")}`, data: { webhookId: made.webhook.id, url: made.webhook.url } });
    return json(made, 201);
  } catch (e) {
    if (e instanceof WebhookError) throw new HttpError(400, e.message);
    throw e;
  }
}, { write: true, role: "admin", sessionOnly: true });
