import { FixError, proposeFix } from "@/lib/diagnostics/fix";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Files the fix a finding states as a change for review. Nothing is applied: a person approves and applies it like any other change. */
export const POST = route(async (_req, params) => {
  try {
    return json(await proposeFix(params.id), 201);
  } catch (e) {
    if (e instanceof FixError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true });
