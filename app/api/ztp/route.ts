import { z } from "zod";
import { ChangeError } from "@/lib/changes/engine";
import { findUnconfigured, proposeProvisioning } from "@/lib/changes/ztp";
import { getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const scope = (req: Request) => {
  const { db } = getContext();
  const id = new URL(req.url).searchParams.get("scope") ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
};

/** Which devices in the network look unconfigured. Read-only. */
export const GET = route(async (req) => {
  try {
    const scopeId = scope(req);
    return json({ scopeId, candidates: await findUnconfigured(scopeId) });
  } catch (e) {
    if (e instanceof ChangeError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

const body = z.object({ title: z.string().max(120).optional(), plan: z.unknown() }).strict();

/** Turns a provisioning plan into a proposed change. Nothing is applied. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  try {
    return json(await proposeProvisioning(scope(req), b.plan, b.title), 201);
  } catch (e) {
    if (e instanceof ChangeError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true });
