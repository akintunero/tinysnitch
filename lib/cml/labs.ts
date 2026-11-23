import { z } from "zod";

export type LabSummary = {
  id: string;
  title: string;
  state: string;
  nodeCount: number | null;
  linkCount: number | null;
  owner: string | null;
  description: string;
  /** Which provider the scope comes from. Absent on a bare CML lab, which is `cml`. */
  providerId?: string;
  providerKind?: "cml" | "static" | "netbox" | "discovery";
  environment?: "lab" | "production";
};

export class CmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmlParseError";
  }
}

// Only fields we rely on are required; CML may add others and we keep them out of the way.
const labSchema = z.looseObject({
  id: z.string(),
  lab_title: z.string(),
  state: z.string().optional(),
  node_count: z.number().optional(),
  link_count: z.number().optional(),
  owner_username: z.string().optional(),
  lab_description: z.string().optional(),
});

/** Accepts a bare array, {"result": [...]}, or one lab object, as MCP servers vary. */
export function parseLabs(text: string): LabSummary[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CmlParseError("The lab list was not JSON, so it was not used.");
  }
  if (data && typeof data === "object" && !Array.isArray(data) && "result" in data) data = (data as { result: unknown }).result;
  const list = Array.isArray(data) ? data : [data];
  const out: LabSummary[] = [];
  for (const item of list) {
    const r = labSchema.safeParse(item);
    if (!r.success) throw new CmlParseError("A lab in the list did not have the expected id and lab_title fields.");
    const l = r.data;
    out.push({
      id: l.id,
      title: l.lab_title,
      state: l.state ?? "UNKNOWN",
      nodeCount: l.node_count ?? null,
      linkCount: l.link_count ?? null,
      owner: l.owner_username ?? null,
      description: l.lab_description ?? "",
    });
  }
  return out;
}

/** Totals are computed here, never by the model. */
export function labTotals(labs: LabSummary[]) {
  const sum = (f: (l: LabSummary) => number | null) => labs.reduce((n, l) => n + (f(l) ?? 0), 0);
  return {
    labs: labs.length,
    running: labs.filter((l) => l.state === "STARTED").length,
    nodes: sum((l) => l.nodeCount),
    links: sum((l) => l.linkCount),
  };
}
