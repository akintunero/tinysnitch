import { z } from "zod";
import { ChatBusyError, type ChatEvent, UnknownConversationError, runChat } from "@/lib/assistant/chat";
import { HttpError, readJson, route } from "@/lib/server/http";
import { getSettings } from "@/lib/database/repo";
import { providerFor } from "@/lib/providers/registry";
import { getContext } from "@/lib/server/context";
import { requireMcp } from "@/lib/server/labs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, "Write a message first.").max(4000, "That message is too long (4000 characters at most)."),
});

/**
 * Streams one assistant turn as newline-delimited JSON events. Missing configuration is refused up front with a
 * proper status code; once streaming starts, problems arrive as an "error" event.
 */
export const POST = route(async (req) => {
  const { message, conversationId } = await readJson(req, body);
  const ctx = getContext();
  // A network that is not a CML lab is reached through its own provider, so the CML connection is not required for it.
  const selected = getSettings(ctx.db).selectedLabId;
  const direct = selected ? providerFor(selected).provider : null;
  const mcp = direct && direct.kind !== "cml" ? ctx.mcp : (await requireMcp()).mcp;
  if (!ctx.anthropic) throw new HttpError(503, ctx.claude.configError ?? "Claude is not configured.", "claude_unavailable");
  const live = { ...ctx, anthropic: ctx.anthropic, mcp };

  const enc = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: ChatEvent) => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the client went away */
        }
      };
      try {
        await runChat(live, { conversationId, message, signal: abort.signal, emit });
      } catch (e) {
        if (e instanceof ChatBusyError) emit({ type: "error", message: "This conversation is still answering the previous message." });
        else if (e instanceof UnknownConversationError) emit({ type: "error", message: "That conversation no longer exists." });
        else emit({ type: "error", message: "The assistant failed unexpectedly. The details are in the activity log." });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}, { write: true });
