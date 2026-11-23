import { devicesWithBackups, latestBackup } from "@/lib/backup/store";
import { getSettings } from "@/lib/database/repo";
import { detectRunning } from "@/lib/provisioning/detect";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * What each device's latest stored configuration says it runs. It reads the backups, not the devices, so it is instant and
 * touches nothing; each device says how old the copy is.
 */
export const GET = route(async (req) => {
  const { db } = getContext();
  const id = new URL(req.url).searchParams.get("scope") ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const scope = LAB_ID.safeParse(id);
  if (!scope.success) throw new HttpError(400, scope.error.issues[0].message);
  const devices = devicesWithBackups(db, scope.data).map((d) => {
    const b = latestBackup(db, scope.data, d.device);
    return { device: d.device, takenAt: d.latest.takenAt, running: b ? detectRunning(b.config) : [] };
  });
  return json({ scopeId: scope.data, devices });
});
