import { z } from "zod";
import { deleteChanges } from "@/lib/changes/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, readJson, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const body = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict();

/** Removes the chosen changes. Any that are still in flight are skipped and listed, the rest go. Recorded in Activity. */
export const POST = route(async (req) => {
  const { ids } = await readJson(req, body);
  const { db } = getContext();
  const r = deleteChanges(db, [...new Set(ids)]);
  if (r.removed.length) addAudit(db, { kind: "configuration", actor: "user", summary: `Removed ${r.removed.length} change${r.removed.length === 1 ? "" : "s"}: ${r.removed.map((c) => `"${c.title}"`).join(", ").slice(0, 300)}`, data: { removed: r.removed.map((c) => ({ id: c.id, status: c.status, scopeId: c.scopeId })), skipped: r.skipped.length } });
  return json({ removed: r.removed.length, skipped: r.skipped });
}, { write: true, role: "approver" });
