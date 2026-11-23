import { z } from "zod";
import { FINISHED, clearFinished } from "@/lib/changes/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ scopeId: z.string().min(1).max(120) }).strict();

/** Clears the changes of one network that are settled: verified, rolled back or rejected. Nothing in flight or needing attention is touched. */
export const POST = route(async (req) => {
  const { scopeId } = await readJson(req, body);
  const { db } = getContext();
  const removed = clearFinished(db, scopeId);
  addAudit(db, { kind: "configuration", actor: "user", summary: `Cleared ${removed} finished change${removed === 1 ? "" : "s"} (${FINISHED.map((s) => s.replace("_", " ")).join(", ")})`, data: { scopeId, removed } });
  return json({ removed });
}, { write: true, role: "approver" });
