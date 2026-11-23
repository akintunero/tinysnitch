import { runHistory } from "@/lib/diagnostics/store";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Findings over time for a network, from its saved diagnostic runs, oldest first. */
export const GET = route(async (_req, params) => {
  const r = LAB_ID.safeParse(params.labId);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return json({ points: runHistory(getContext().db, r.data) });
});
