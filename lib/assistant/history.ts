import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../database/db";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; tool: string; input: unknown; ok: boolean | null; output: string; ms: number | null };

export type StoredMessage = { id: number; role: "user" | "assistant"; parts: Part[]; error: string | null; at: string };
export type Conversation = { id: string; labId: string | null; title: string; createdAt: string };

export function createConversation(db: Db, labId: string | null, firstMessage: string): Conversation {
  const c: Conversation = { id: randomUUID(), labId, title: firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation", createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO conversations (id, lab_id, title, created_at) VALUES (?, ?, ?, ?)").run(c.id, c.labId, c.title, c.createdAt);
  return c;
}

export function getConversation(db: Db, id: string): Conversation | null {
  const r = db.prepare("SELECT id, lab_id, title, created_at FROM conversations WHERE id = ?").get(id) as { id: string; lab_id: string | null; title: string; created_at: string } | undefined;
  return r ? { id: r.id, labId: r.lab_id, title: r.title, createdAt: r.created_at } : null;
}

export function listConversations(db: Db, labId: string | null, limit = 50): Conversation[] {
  const rows = (labId
    ? db.prepare("SELECT id, lab_id, title, created_at FROM conversations WHERE lab_id = ? ORDER BY created_at DESC LIMIT ?").all(labId, limit)
    : db.prepare("SELECT id, lab_id, title, created_at FROM conversations ORDER BY created_at DESC LIMIT ?").all(limit)) as { id: string; lab_id: string | null; title: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, labId: r.lab_id, title: r.title, createdAt: r.created_at }));
}

export function deleteConversation(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes) > 0;
}

export function addMessage(db: Db, conversationId: string, role: "user" | "assistant", parts: Part[], error: string | null = null): number {
  const r = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(conversationId, role, JSON.stringify({ parts, error }), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function getMessages(db: Db, conversationId: string): StoredMessage[] {
  const rows = db.prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as { id: number; role: "user" | "assistant"; content: string; created_at: string }[];
  return rows.map((r) => {
    let body: { parts?: Part[]; error?: string | null } = {};
    try {
      body = JSON.parse(r.content);
    } catch {
      /* an unreadable row shows as empty rather than breaking the conversation */
    }
    return { id: r.id, role: r.role, parts: body.parts ?? [], error: body.error ?? null, at: r.created_at };
  });
}

const textOf = (m: StoredMessage) => m.parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map((p) => p.text).join("").trim();

/**
 * What goes back to Claude from earlier turns: the words only. Tool calls and device output are dropped on
 * purpose, so old readings can't be mistaken for the network's current state; Claude must look again.
 */
export function replayHistory(stored: StoredMessage[], opts: { maxMessages?: number; maxChars?: number } = {}): Anthropic.MessageParam[] {
  const maxMessages = opts.maxMessages ?? 20;
  const maxChars = opts.maxChars ?? 24_000;
  const turns = stored.map((m) => ({ role: m.role, text: textOf(m) })).filter((t) => t.text).slice(-maxMessages);
  let total = 0;
  const kept: typeof turns = [];
  for (const t of [...turns].reverse()) {
    total += t.text.length;
    if (total > maxChars && kept.length) break;
    kept.unshift(t);
  }
  const out: Anthropic.MessageParam[] = [];
  for (const t of kept) {
    const last = out.at(-1);
    if (last && last.role === t.role) last.content = `${last.content as string}\n\n${t.text}`; // roles must alternate
    else out.push({ role: t.role, content: t.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
