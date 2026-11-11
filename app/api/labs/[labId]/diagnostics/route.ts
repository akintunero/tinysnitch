import { z } from "zod";
import { deriveFromRun } from "@/lib/diagnostics/state";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { latestRun, openFindings } from "@/lib/diagnostics/store";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { fetchTopology } from "@/lib/server/topology";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const labId = (params: Record<string, string>) => {
  const r = LAB_ID.safeParse(params.labId);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
};

/** The latest saved run, its open findings, and the link colours and node flags they imply for the topology. */
export const GET = route(async (_req, params) => {
  const id = labId(params);
  const { db } = getContext();
  const run = latestRun(db, id);
  const findings = run ? openFindings(db, id) : [];
  let derived: ReturnType<typeof deriveFromRun> = { links: {}, nodeFaults: {} };
  let topologyError: string | null = null;
  if (run) {
    try {
      derived = deriveFromRun(await fetchTopology(id), run, findings);
    } catch (e) {
      topologyError = e instanceof Error ? e.message : "The topology could not be read.";
    }
  }
  return json({ run, findings, ...derived, topologyError });
});

const body = z.object({ pings: z.boolean().optional() }).strict();

/** Runs read-only diagnostics now. Nothing is written to any device. */
export const POST = route(async (req, params) => {
  const id = labId(params);
  const { pings } = await readJson(req, body);
  const result = await runDiagnostics(id, { pings });
  const derived = deriveFromRun(await fetchTopology(id), result.run, result.findings);
  return json({ run: { ...result.run, interpretation: null }, findings: result.findings, opened: result.opened, cleared: result.cleared, ...derived, topologyError: null });
}, { write: true });
