import { getSettings } from "@/lib/database/repo";
import { openFindings } from "@/lib/diagnostics/store";
import { computeImpact } from "@/lib/provisioning/impact";
import { listServices } from "@/lib/provisioning/instances";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/**
 * Which open findings hurt which services, and which findings each service is exposed to, from the latest diagnostics run.
 * Read-only: it joins what the devices reported with what was provisioned, and touches nothing.
 */
export const GET = route(async (req) => {
  const { db } = getContext();
  const id = new URL(req.url).searchParams.get("scope") ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const scope = LAB_ID.safeParse(id);
  if (!scope.success) throw new HttpError(400, scope.error.issues[0].message);
  const findings = openFindings(db, scope.data);
  return json({ scopeId: scope.data, ...computeImpact(listServices(db, scope.data), findings) });
});
