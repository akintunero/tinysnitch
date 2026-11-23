import { z } from "zod";
import { getSettings } from "@/lib/database/repo";
import { ProvisionError, renderFor, serviceById, validate } from "@/lib/provisioning/catalog";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { fetchTopology } from "@/lib/server/topology";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

const body = z.object({
  scopeId: z.string().optional(),
  service: z.string().min(1).max(60),
  values: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])),
  devices: z.array(z.string().min(1).max(120)).min(1).max(20),
}).strict();

/**
 * Turns a service form into the configuration lines for each chosen device. Nothing is sent to any device and no
 * change is filed: the page shows this as a preview, and the person then files it as an ordinary change.
 */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const def = serviceById(b.service);
  if (!def) throw new HttpError(404, "No such service.");
  const scope = b.scopeId ?? getSettings(getContext().db).selectedLabId;
  if (!scope) throw new HttpError(409, "Select a network first.");
  const id = LAB_ID.safeParse(scope);
  if (!id.success) throw new HttpError(400, id.error.issues[0].message);

  let values;
  try {
    values = validate(def, b.values);
  } catch (e) {
    if (e instanceof ProvisionError) throw new HttpError(400, e.message);
    throw e;
  }
  const topology = await fetchTopology(id.data);
  const chosen = b.devices.map((label) => {
    const node = topology.nodes.find((n) => n.label === label);
    if (!node) throw new HttpError(404, `${label} is not a device of this network.`);
    return { label: node.label, platform: node.platform ?? ("ios" as const) };
  });
  return json({ service: def.id, title: def.title, devices: renderFor(def, values, chosen) });
}, { write: true });
