import { getBackup } from "@/lib/backup/store";
import { getContext } from "@/lib/server/context";
import { HttpError, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The stored configuration as a text file. It was masked for secrets before it was stored. */
export const GET = route(async (_req, params) => {
  const id = /^\d{1,12}$/.test(params.id) ? Number(params.id) : null;
  const b = id === null ? null : getBackup(getContext().db, id);
  if (!b) throw new HttpError(404, "No such backup.");
  const safe = `${b.device}-${b.takenAt}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  return new Response(b.config, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${safe}.cfg"`, "Cache-Control": "no-store" } });
});
