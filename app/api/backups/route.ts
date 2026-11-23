import { devicesWithBackups, listDrift } from "@/lib/backup/store";
import { getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** What has been backed up for a network, the drift that has not been acknowledged, and whether it is on a schedule. */
export const GET = route(async (req) => {
  const { db } = getContext();
  const settings = getSettings(db);
  const id = new URL(req.url).searchParams.get("scope") ?? settings.selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return json({
    scopeId: r.data,
    devices: devicesWithBackups(db, r.data),
    drift: listDrift(db, r.data),
    monitored: settings.monitoredScopes.includes(r.data),
    backupIntervalMinutes: settings.backupIntervalMinutes,
    diagnosticsIntervalMinutes: settings.diagnosticsIntervalMinutes,
  });
});
