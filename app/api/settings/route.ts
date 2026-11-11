import { addAudit, getSettings, saveSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, readJson, route } from "@/lib/server/http";
import { settingsPatchSchema } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => json(getSettings(getContext().db)));

export const PUT = route(async (req) => {
  const patch = await readJson(req, settingsPatchSchema);
  const { db } = getContext();
  const before = getSettings(db);
  const after = saveSettings(db, patch);
  const changed = Object.keys(patch).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
  if (changed.length) addAudit(db, { kind: "settings", actor: "user", summary: `Changed settings: ${changed.join(", ")}`, data: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])) });
  return json(after);
}, { write: true });
