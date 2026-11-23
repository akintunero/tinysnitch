import { clearConversations, listConversations } from "@/lib/assistant/history";
import { addAudit, getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Conversations for the selected lab (all of them when no lab is selected). */
export const GET = route(async () => {
  const { db } = getContext();
  return json({ conversations: listConversations(db, getSettings(db).selectedLabId) });
});

/** Deletes every conversation of the selected network. */
export const DELETE = route(async () => {
  const { db } = getContext();
  const labId = getSettings(db).selectedLabId;
  const removed = clearConversations(db, labId);
  addAudit(db, { kind: "request", actor: "user", summary: `Deleted ${removed} conversation${removed === 1 ? "" : "s"}`, data: { labId, removed } });
  return json({ removed });
}, { write: true });
