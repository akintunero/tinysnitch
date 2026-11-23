import { z } from "zod";
import { asHttp } from "@/lib/provisioning/http";
import { forgetService, getService, modifyService } from "@/lib/provisioning/instances";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** One service with the story of the changes filed for it. */
export const GET = route(async (_req, params) => {
  const s = getService(getContext().db, params.id);
  if (!s) throw new HttpError(404, "No such service.");
  return json(s);
});

const patch = z.object({
  name: z.string().min(1).max(100).optional(),
  values: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  devices: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
  dryRun: z.boolean().optional(),
}).strict();

/** Changes a service. With `dryRun` it only shows the lines each device would get. Otherwise it files the change. */
export const PUT = route(async (req, params) => {
  const { dryRun, ...rest } = await readJson(req, patch);
  try {
    return json(await modifyService(params.id, rest, { dryRun }));
  } catch (e) {
    return asHttp(e);
  }
}, { write: true });

/** Stops tracking a service. Nothing is sent to any device. */
export const DELETE = route(async (_req, params) => {
  try {
    forgetService(params.id);
    return json({ forgotten: true });
  } catch (e) {
    return asHttp(e);
  }
}, { write: true, role: "approver" });
