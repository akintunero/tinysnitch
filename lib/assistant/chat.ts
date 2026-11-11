import type Anthropic from "@anthropic-ai/sdk";
import { AbortedError, type MessagesClient, describeApiError, runToolLoop } from "../anthropic/bridge";
import { addAudit, getSettings } from "../database/repo";
import type { Ctx } from "../server/context";
import { createExecutor } from "./executor";
import { type Part, addMessage, createConversation, getConversation, getMessages, replayHistory } from "./history";
import { providerFor } from "../providers/registry";
import { NEUTRAL_TOOLS, createNeutralExecutor } from "./neutral";
import { PROPOSE_TOOL } from "./propose";
import { buildToolSet } from "./policy";
import { buildSystem } from "./system";
import type { McpService } from "../mcp/service";

async function isProduction(scopeId: string): Promise<boolean> {
  try {
    return (await providerFor(scopeId).provider?.getTopology(scopeId))?.lab.environment === "production";
  } catch {
    return true; // when unsure, behave as if it is production
  }
}

export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; output: string; ms: number | null }
  | { type: "done"; toolCalls: number; stopReason: string | null }
  | { type: "error"; message: string };

const DISPLAY_OUTPUT_CHARS = 6000;
const active = new Set<string>();

export class ChatBusyError extends Error {}
export class UnknownConversationError extends Error {}

/**
 * One assistant turn: store the question, let Claude read the lab through the allowed tools, stream what
 * happens, and store the result. A failed or stopped turn is still stored, so the transcript stays honest.
 */
export async function runChat(
  ctx: Ctx & { anthropic: NonNullable<Ctx["anthropic"]>; mcp: McpService | null },
  input: { conversationId?: string; message: string; signal?: AbortSignal; emit: (e: ChatEvent) => void },
): Promise<void> {
  const { db, mcp } = ctx;
  const settings = getSettings(db);
  const model = ctx.claude.model;
  if (!model) throw new Error("Claude has no model configured.");

  let conv = input.conversationId ? getConversation(db, input.conversationId) : null;
  if (input.conversationId && !conv) throw new UnknownConversationError();
  if (conv && active.has(conv.id)) throw new ChatBusyError();
  conv ??= createConversation(db, settings.selectedLabId, input.message);
  active.add(conv.id);

  try {
    const history = replayHistory(getMessages(db, conv.id));
    addMessage(db, conv.id, "user", [{ type: "text", text: input.message }]);
    addAudit(db, { kind: "request", actor: "user", summary: `Asked the assistant: ${input.message.replace(/\s+/g, " ").slice(0, 120)}`, data: { conversationId: conv.id, labId: settings.selectedLabId } });
    input.emit({ type: "conversation", id: conv.id, title: conv.title });

    const messages: Anthropic.MessageParam[] = [...history];
    const last = messages.at(-1);
    if (last?.role === "user") last.content = `${last.content as string}\n\n${input.message}`;
    else messages.push({ role: "user", content: input.message });

    // CML networks use the MCP server's own read tools; every other network goes through its provider and transport.
    const scoped = settings.selectedLabId ? providerFor(settings.selectedLabId).provider : null;
    const neutral = scoped && scoped.kind !== "cml" ? scoped : null;
    if (!neutral && !mcp) throw new Error("The CML MCP connection is not available.");
    const cmlToolSet = neutral ? null : buildToolSet(mcp!.tools());
    const tools = neutral ? NEUTRAL_TOOLS : [...cmlToolSet!.tools, ...(settings.selectedLabId ? [PROPOSE_TOOL] : [])];
    const parts: Part[] = [];
    const toolPart = (id: string) => parts.find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.id === id);
    const execute = neutral ? createNeutralExecutor({ db, provider: neutral, scopeId: settings.selectedLabId! }) : createExecutor({ db, mcp: mcp!, toolSet: cmlToolSet!, scopeId: settings.selectedLabId });

    let error: string | null = null;
    let toolCalls = 0;
    let stopReason: string | null = null;
    try {
      const result = await runToolLoop({
        client: ctx.anthropic as unknown as MessagesClient,
        model,
        system: buildSystem(settings.selectedLabId ? { id: settings.selectedLabId, title: settings.selectedLabTitle ?? settings.selectedLabId } : null, settings.executionMode, neutral ? { production: scoped ? await isProduction(settings.selectedLabId!) : false, direct: true } : undefined),
        messages,
        tools,
        execute,
        maxToolCalls: 12,
        signal: input.signal,
        onText: (delta) => {
          const tail = parts.at(-1);
          if (tail?.type === "text") tail.text += delta;
          else parts.push({ type: "text", text: delta });
          input.emit({ type: "text", delta });
        },
        onToolUse: (id, tool, args) => {
          parts.push({ type: "tool", id, tool, input: args, ok: null, output: "", ms: null });
          input.emit({ type: "tool_start", id, tool, input: args });
        },
        onToolResult: (id, _tool, r) => {
          const output = r.content.length > DISPLAY_OUTPUT_CHARS ? `${r.content.slice(0, DISPLAY_OUTPUT_CHARS)}\n[shown truncated]` : r.content;
          const p = toolPart(id);
          if (p) Object.assign(p, { ok: !r.isError, output, ms: r.durationMs ?? null });
          input.emit({ type: "tool_result", id, ok: !r.isError, output, ms: r.durationMs ?? null });
        },
      });
      toolCalls = result.toolCalls;
      stopReason = result.stopReason;
      // Without streaming nothing was emitted as text; make sure the answer is in the transcript either way.
      if (!parts.some((p) => p.type === "text" && p.text.trim()) && result.text.trim()) {
        parts.push({ type: "text", text: result.text });
        input.emit({ type: "text", delta: result.text });
      }
    } catch (e) {
      error = e instanceof AbortedError ? "Stopped before it finished." : describeApiError(e);
      if (!(e instanceof AbortedError)) addAudit(db, { kind: "error", actor: "system", summary: `Assistant turn failed: ${error}`, data: { conversationId: conv.id } });
    }

    addMessage(db, conv.id, "assistant", parts, error);
    if (error) input.emit({ type: "error", message: error });
    else input.emit({ type: "done", toolCalls, stopReason });
  } finally {
    active.delete(conv.id);
  }
}
