import { z } from "zod";
import { addAudit, getSettings, saveSettings } from "@/lib/database/repo";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { fetchLabs } from "@/lib/server/labs";

export const dynamic = "force-dynamic";

const body = z.object({ id: z.string().min(1).nullable() });

/** The selection is checked against CML's own list, so a stale or invented id can't be stored. */
export const POST = route(async (req) => {
  const { id } = await readJson(req, body);
  const ctx = getContext();
  if (id === null) {
    saveSettings(ctx.db, { selectedLabId: null, selectedLabTitle: null });
    return json({ selectedLabId: null, selectedLabTitle: null });
  }
  const lab = (await fetchLabs()).find((l) => l.id === id);
  if (!lab) throw new HttpError(404, "CML has no lab with that id.");
  saveSettings(ctx.db, { selectedLabId: lab.id, selectedLabTitle: lab.title });
  addAudit(ctx.db, { kind: "lab", actor: "user", summary: `Selected lab "${lab.title}"`, data: { labId: lab.id } });
  // The user opted in to read-only diagnostics on selection. It runs in the background; the response does not wait.
  if (getSettings(ctx.db).diagnosticsOnLabSelect) {
    void runDiagnostics(lab.id).catch((e) => addAudit(ctx.db, { kind: "error", summary: `Diagnostics on selection failed: ${e instanceof Error ? e.message : "unknown error"}` }));
  }
  return json({ selectedLabId: lab.id, selectedLabTitle: lab.title });
}, { write: true });
