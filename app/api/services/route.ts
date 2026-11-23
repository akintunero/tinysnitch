import { z } from "zod";
import { getSettings } from "@/lib/database/repo";
import { asHttp } from "@/lib/provisioning/http";
import { createService, listServices } from "@/lib/provisioning/instances";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

const scopeOf = (db: ReturnType<typeof getContext>["db"], given?: string | null) => {
  const id = given ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
};

/** The services provisioned in a network, newest first. Retired ones are left out unless `retired=1`. */
export const GET = route(async (req) => {
  const { db } = getContext();
  const q = new URL(req.url).searchParams;
  const scopeId = scopeOf(db, q.get("scope"));
  return json({ scopeId, services: listServices(db, scopeId, { includeRetired: q.get("retired") === "1" }) });
});

const body = z.object({
  scopeId: z.string().optional(),
  serviceId: z.string().min(1).max(60),
  name: z.string().min(1).max(100),
  values: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])),
  devices: z.array(z.string().min(1).max(120)).min(1).max(20),
}).strict();

/** Provisions a service: remembers it and files the change that puts it on the devices. Nothing is sent until the change is approved and applied. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  try {
    const r = await createService({ scopeId: scopeOf(db, b.scopeId), serviceId: b.serviceId, name: b.name, values: b.values, devices: b.devices });
    return json(r, 201);
  } catch (e) {
    return asHttp(e);
  }
}, { write: true });
