import { z } from "zod";
import { deleteConversation, getConversation, getMessages } from "@/lib/assistant/history";
import { addAudit } from "@/lib/database/repo";
import { getContext } from "@/lib/server/context";
import { HttpError, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const id = (params: Record<string, string>) => {
  const r = z.uuid().safeParse(params.id);
  if (!r.success) throw new HttpError(400, "That is not a valid conversation id.");
  return r.data;
};

export const GET = route(async (_req, params) => {
  const { db } = getContext();
  const conversation = getConversation(db, id(params));
  if (!conversation) throw new HttpError(404, "No such conversation.");
  return json({ conversation, messages: getMessages(db, conversation.id) });
});

export const DELETE = route(async (_req, params) => {
  const { db } = getContext();
  const cid = id(params);
  if (!deleteConversation(db, cid)) throw new HttpError(404, "No such conversation.");
  addAudit(db, { kind: "request", actor: "user", summary: "Deleted a conversation", data: { conversationId: cid } });
  return json({ deleted: true });
}, { write: true });
