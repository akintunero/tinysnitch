import { z } from "zod";
import { BackupError, runBackups } from "@/lib/backup/engine";
import { getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({ scopeId: z.string().optional() }).strict();

/** Reads every readable device's configuration now and stores new versions. Read-only on the devices. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db } = getContext();
  const id = b.scopeId ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  try {
    return json(await runBackups(r.data, "manual", "user"));
  } catch (e) {
    if (e instanceof BackupError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true });
