import type { MessagesClient } from "@/lib/anthropic/bridge";
import { addAudit } from "@/lib/database/repo";
import { pseudonymisingClient } from "@/lib/privacy/client";
import { auditPrivacy, pseudonymiserFor } from "@/lib/privacy/session";
import { interpretFindings } from "@/lib/diagnostics/interpret";
import { latestRun, openFindings, setInterpretation } from "@/lib/diagnostics/store";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";
import { fetchTopology } from "@/lib/server/topology";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Asks Claude to explain the latest run's findings. It can explain; it cannot add findings. */
export const POST = route(async (_req, params) => {
  const parsed = LAB_ID.safeParse(params.labId);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  const ctx = getContext();
  const run = latestRun(ctx.db, parsed.data);
  if (!run) throw new HttpError(404, "Run diagnostics first; there is nothing to explain yet.");
  const findings = openFindings(ctx.db, parsed.data);
  if (findings.length && (!ctx.anthropic || !ctx.claude.model)) throw new HttpError(503, ctx.claude.configError ?? "Claude is not configured.", "claude_unavailable");

  let text: string;
  const pseudo = findings.length ? await pseudonymiserFor(ctx.db, parsed.data) : null;
  try {
    const client = ctx.anthropic as NonNullable<typeof ctx.anthropic>;
    // Only the findings' own text goes out, and through the same masking wrapper as the assistant.
    const masked = pseudo ? (pseudonymisingClient(client as unknown as MessagesClient, pseudo) as unknown as typeof client) : client;
    text = await interpretFindings(masked, ctx.claude.model ?? "", { labTitle: (await labTitle(parsed.data)) ?? parsed.data, findings, run });
  } catch (e) {
    addAudit(ctx.db, { kind: "error", summary: `Explaining findings failed: ${(e as Error).message}` });
    throw new HttpError(502, (e as Error).message);
  }
  if (findings.length) auditPrivacy(ctx.db, "Explain findings", pseudo, parsed.data);
  setInterpretation(ctx.db, run.id, text);
  if (findings.length) addAudit(ctx.db, { kind: "claude", actor: "user", summary: `Claude explained ${findings.length} diagnostic findings`, data: { runId: run.id } });
  return json({ text, runId: run.id });
}, { write: true });

async function labTitle(id: string): Promise<string | null> {
  try {
    return (await fetchTopology(id)).lab.title;
  } catch {
    return null; // the title is only context for the explanation
  }
}
