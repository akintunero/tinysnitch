import { getChange } from "@/lib/changes/store";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, params) => {
  const c = getChange(getContext().db, params.id);
  if (!c) throw new HttpError(404, "No such change.");
  return json(c);
});
