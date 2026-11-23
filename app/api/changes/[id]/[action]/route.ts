import { ChangeError, type Override, approveChange, assertContinuable, assertDeployable, assertRollbackable, continueChange, deployChange, rejectChange, rollbackChange, saveChange, scheduleChange } from "@/lib/changes/engine";
import { getChange } from "@/lib/changes/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, requireRole, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * approve, reject and save answer at once. deploy and rollback can take minutes on real devices, so they check what
 * they can up front, answer 202 with the change in its "deploying"/"rolling back" state, and carry on in the
 * background; the page polls the change until it settles.
 */
/** An optional JSON body: `overrideReason` applies a production change outside its maintenance window; `at` schedules it. */
async function bodyOf(req: Request): Promise<{ overrideReason?: string; at?: string | null }> {
  try { const b = (await req.json()) as Record<string, unknown>; return { overrideReason: typeof b.overrideReason === "string" ? b.overrideReason : undefined, at: typeof b.at === "string" || b.at === null ? (b.at as string | null) : undefined }; } catch { return {}; }
}
const overrideOf = (b: { overrideReason?: string }): Override | undefined => {
  if (!b.overrideReason) return undefined;
  requireRole("admin"); // applying outside the maintenance window is an administrator's decision
  return { reason: b.overrideReason };
};

export const POST = route(async (req, params) => {
  const { db } = getContext();
  const { id, action } = params;
  requireRole("approver"); // every action here approves, applies, schedules, saves or undoes a change
  try {
    switch (action) {
      case "approve": return json(approveChange(id));
      case "reject": return json(rejectChange(id));
      case "save": return json(await saveChange(id));
      case "deploy": {
        const o = overrideOf(await bodyOf(req));
        assertDeployable(id, o, false); // checked now so a refusal reaches the caller; the override is recorded once, when it runs
        void deployChange(id, o).catch((e) => addAudit(db, { kind: "error", summary: `Deployment of ${id} stopped: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` }));
        return json(getChange(db, id), 202);
      }
      case "continue": {
        const o = overrideOf(await bodyOf(req));
        assertContinuable(id, o, false);
        void continueChange(id, o).catch((e) => addAudit(db, { kind: "error", summary: `Continuing ${id} stopped: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` }));
        return json(getChange(db, id), 202);
      }
      case "schedule": {
        const b = await bodyOf(req);
        if (b.at === undefined) throw new HttpError(400, "Send { \"at\": <ISO time> } to schedule, or { \"at\": null } to cancel.");
        return json(scheduleChange(id, b.at === null ? null : new Date(b.at)));
      }
      case "rollback": {
        assertRollbackable(id);
        void rollbackChange(id).catch((e) => addAudit(db, { kind: "error", summary: `Rollback of ${id} stopped: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` }));
        return json(getChange(db, id), 202);
      }
      default: throw new HttpError(404, "Unknown action.");
    }
  } catch (e) {
    if (e instanceof ChangeError) throw new HttpError(e.status, e.message);
    throw e;
  }
}, { write: true });
