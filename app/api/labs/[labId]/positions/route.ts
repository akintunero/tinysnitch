import { z } from "zod";
import { clearPositions, getPositions, savePositions } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID, NODE_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

const coord = z.number().finite().min(-100_000).max(100_000);
const body = z.object({ positions: z.record(NODE_ID, z.object({ x: coord, y: coord })).refine((p) => Object.keys(p).length <= 500, "Too many nodes.") });

function labId(params: Record<string, string>): string {
  const r = LAB_ID.safeParse(params.labId);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
}

/** Positions the user dragged nodes to, kept per lab so the layout survives reloads. */
export const GET = route(async (_req, params) => json({ positions: getPositions(getContext().db, labId(params)) }));

export const PUT = route(async (req, params) => {
  const id = labId(params);
  const { positions } = await readJson(req, body);
  savePositions(getContext().db, id, positions);
  return json({ saved: Object.keys(positions).length });
}, { write: true });

export const DELETE = route(async (_req, params) => {
  clearPositions(getContext().db, labId(params));
  return json({ cleared: true });
}, { write: true });
