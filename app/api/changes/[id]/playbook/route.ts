import { PlaybookError, renderPlaybook } from "@/lib/changes/playbook";
import { getChange } from "@/lib/changes/store";
import { getContext } from "@/lib/server/context";
import { HttpError, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** The change as an Ansible playbook, for review or for a pipeline that already runs Ansible. Reads only. */
export const GET = route(async (_req, params) => {
  const c = getChange(getContext().db, params.id);
  if (!c) throw new HttpError(404, "No such change.");
  const name = c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "change";
  let body: string;
  try {
    body = renderPlaybook(c);
  } catch (e) {
    if (e instanceof PlaybookError) throw new HttpError(400, e.message);
    throw e;
  }
  return new Response(body, {
    headers: { "Content-Type": "text/yaml; charset=utf-8", "Content-Disposition": `attachment; filename="tiny-snitch-${name}.yml"`, "Cache-Control": "no-store" },
  });
});
