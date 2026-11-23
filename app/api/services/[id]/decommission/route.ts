import { z } from "zod";
import { decommissionService } from "@/lib/provisioning/instances";
import { asHttp } from "@/lib/provisioning/http";
import { json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Takes a service away from its devices through a change. With `dryRun` it only shows the lines. */
export const POST = route(async (req, params) => {
  const { dryRun } = await readJson(req, z.object({ dryRun: z.boolean().optional() }).strict());
  try {
    return json(await decommissionService(params.id, { dryRun }));
  } catch (e) {
    return asHttp(e);
  }
}, { write: true });
