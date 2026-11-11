import { ChangeError, approveChange, assertDeployable, assertRollbackable, deployChange, rejectChange, rollbackChange, saveChange } from "@/lib/changes/engine";
import { getChange } from "@/lib/changes/store";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * approve, reject and save answer at once. deploy and rollback can take minutes on real devices, so they check what
 * they can up front, answer 202 with the change in its "deploying"/"rolling back" state, and carry on in the
 * background; the page polls the change until it settles.
 */
export const POST = route(async (_req, params) => {
  const { db } = getContext();
  const { id, action } = params;
  try {
    switch (action) {
      case "approve": return json(approveChange(id));
      case "reject": return json(rejectChange(id));
      case "save": return json(await saveChange(id));
      case "deploy": {
        assertDeployable(id);
        void deployChange(id).catch((e) => addAudit(db, { kind: "error", summary: `Deployment of ${id} stopped: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` }));
        return json(getChange(db, id), 202);
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
