import { sendTest } from "@/lib/api/webhooks";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Sends one signed test event to this hook now and reports how the receiver answered. */
export const POST = route(async (_req, params) => {
  const d = await sendTest(getContext().db, params.id);
  if (!d) throw new HttpError(404, "No such webhook.");
  return json(d);
}, { write: true, role: "admin", sessionOnly: true });
