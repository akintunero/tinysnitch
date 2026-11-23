import { getWebhook, listDeliveries } from "@/lib/api/webhooks";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, params) => {
  const { db } = getContext();
  if (!getWebhook(db, params.id)) throw new HttpError(404, "No such webhook.");
  return json({ deliveries: listDeliveries(db, params.id, 50) });
}, { role: "admin", sessionOnly: true });
