import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";
import { fetchTopology } from "@/lib/server/topology";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (req, params) => {
  const labId = LAB_ID.parse(params.labId);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const topology = await fetchTopology(labId, refresh);
  if (refresh) addAudit(getContext().db, { kind: "lab", actor: "user", summary: `Refreshed topology of "${topology.lab.title}"`, data: { labId, nodes: topology.nodes.length, links: topology.links.length } });
  return json(topology);
});
