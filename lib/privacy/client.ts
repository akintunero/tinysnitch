/**
 * Wraps the Messages client so that everything leaving for the model is pseudonymised and everything coming back is
 * restored. This is the single place data crosses to the model for the assistant and for Explain, so nothing built on
 * top of it can forget to mask: system prompt, the conversation, tool results, and the arguments the model asks tools
 * to run with (restored before the tool is executed).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient, StreamLike } from "../anthropic/bridge";
import { type Pseudonymiser, StreamRestorer } from "./pseudonym";

type Params = Anthropic.MessageCreateParamsNonStreaming;

function maskBlock(p: Pseudonymiser, b: unknown): unknown {
  const block = b as { type?: string; text?: string; content?: unknown; input?: unknown };
  if (block.type === "text" && typeof block.text === "string") return { ...block, text: p.forward(block.text) };
  if (block.type === "tool_result") return { ...block, content: typeof block.content === "string" ? p.forward(block.content) : Array.isArray(block.content) ? block.content.map((c) => maskBlock(p, c)) : block.content };
  if (block.type === "tool_use") return { ...block, input: p.forwardDeep(block.input) };
  return b;
}

/** Every string in a request, so names it declares anywhere (a hostname line in a tool result) are known before any part is masked. */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === "string") out.push(v);
  else if (depth < 12 && v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

export function maskParams(p: Pseudonymiser, params: Params): Params {
  for (const s of strings([params.system, params.messages])) p.learn(s);
  return {
    ...params,
    system: typeof params.system === "string" ? p.forward(params.system) : params.system,
    messages: params.messages.map((m) => ({ ...m, content: typeof m.content === "string" ? p.forward(m.content) : (m.content as unknown[]).map((b) => maskBlock(p, b)) })) as Anthropic.MessageParam[],
  };
}

export function restoreMessage(p: Pseudonymiser, msg: Anthropic.Message): Anthropic.Message {
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (b.type === "text") return { ...b, text: p.restore(b.text) };
      if (b.type === "tool_use") return { ...b, input: p.restoreDeep(b.input) };
      return b;
    }),
  };
}

export function pseudonymisingClient(client: MessagesClient, p: Pseudonymiser): MessagesClient {
  return {
    messages: {
      create: async (params) => restoreMessage(p, await client.messages.create(maskParams(p, params))),
      ...(client.messages.stream
        ? {
            stream: (params: Params): StreamLike => {
              const inner = client.messages.stream!(maskParams(p, params));
              const restorer = new StreamRestorer(p);
              let listener: ((d: string) => void) | null = null;
              inner.on("text", (d) => { const out = restorer.push(d); if (out) listener?.(out); });
              return {
                on(_event, l) { listener = l; return undefined; },
                async finalMessage() {
                  const msg = await inner.finalMessage();
                  const rest = restorer.flush();
                  if (rest) listener?.(rest);
                  return restoreMessage(p, msg);
                },
                abort: () => inner.abort(),
              };
            },
          }
        : {}),
    },
  };
}
