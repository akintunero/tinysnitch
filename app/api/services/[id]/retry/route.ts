import { z } from "zod";
import { retryService } from "@/lib/provisioning/instances";
import { asHttp } from "@/lib/provisioning/http";
import { json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Tries a failed or never-applied service again by filing a new change for it. With `dryRun` it only shows the lines. */
export const POST = route(async (req, params) => {
  const { dryRun } = await readJson(req, z.object({ dryRun: z.boolean().optional() }).strict());
  try {
    return json(await retryService(params.id, { dryRun }));
  } catch (e) {
    return asHttp(e);
  }
}, { write: true });
