import { z } from "zod";
import { ChangeError, proposeChange } from "@/lib/changes/engine";
import { listChanges } from "@/lib/changes/store";
import { getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

const scopeOf = (req: Request, db: ReturnType<typeof getContext>["db"], given?: string | null) => {
  const id = given ?? new URL(req.url).searchParams.get("scope") ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
};

export const GET = route(async (req) => {
  const { db } = getContext();
  const scopeId = scopeOf(req, db);
  return json({ scopeId, changes: listChanges(db, scopeId), mode: getSettings(db).executionMode });
});

const body = z.object({
  scopeId: z.string().optional(),
  title: z.string().trim().min(1).max(120),
  intent: z.string().max(2000).default(""),
  devices: z.array(z.object({ device: z.string().min(1), commands: z.array(z.string().max(400)).min(1).max(300) })).min(1).max(20),
}).strict();

/** Files a proposal. Nothing is sent to any device. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  try {
    return json(await proposeChange({ scopeId: scopeOf(req, db, b.scopeId), title: b.title, intent: b.intent, source: "user", devices: b.devices }), 201);
  } catch (e) {
    if (e instanceof ChangeError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true });
