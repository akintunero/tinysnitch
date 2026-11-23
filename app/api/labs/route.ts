import { labTotals } from "@/lib/cml/labs";
import { json, route } from "@/lib/server/http";
import { fetchScopes } from "@/lib/server/labs";

export const dynamic = "force-dynamic";

/** Every selectable network from every configured provider. A provider that is down is reported, not fatal. */
export const GET = route(async () => {
  const { labs, warnings } = await fetchScopes();
  return json({ labs, totals: labTotals(labs), warnings });
});
