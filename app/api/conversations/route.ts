import { listConversations } from "@/lib/assistant/history";
import { getSettings } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Conversations for the selected lab (all of them when no lab is selected). */
export const GET = route(async () => {
  const { db } = getContext();
  return json({ conversations: listConversations(db, getSettings(db).selectedLabId) });
});
