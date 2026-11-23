import { ChangeError } from "@/lib/changes/engine";
import { previewChange } from "@/lib/changes/preview";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** What applying the change would do, read from the devices as they are now. Changes nothing. */
export const GET = route(async (_req, params) => {
  try {
    return json(await previewChange(params.id));
  } catch (e) {
    if (e instanceof ChangeError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
