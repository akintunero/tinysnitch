/**
 * An adapter for any server that speaks the OpenAI chat-completions format: OpenAI itself, Azure OpenAI, OpenRouter, vLLM,
 * LM Studio, Ollama and most gateways. Tiny Snitch's own messages (text, a tool request, a tool result) are translated to
 * that format and back, so nothing else in the app knows which provider answered.
 */
import { redactSecrets } from "../security/redact";
import { ipToInt } from "../core/cidr";
import { type ContentBlock, type CreateParams, LlmHttpError, type LlmMessage, type MessageParam, type MessagesClient, type StreamLike, type TextBlock, type ToolUseBlock } from "./types";

type Wire = { role: string; content?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

const textOf = (c: string | { type: string; text?: string }[]) => (typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n"));

/** Tiny Snitch messages to chat-completions messages. A tool result becomes its own `tool` message, placed straight after the request it answers. */
export function toWire(system: string | undefined, messages: MessageParam[]): Wire[] {
  const out: Wire[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: textOf(b.content) });
    const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const parseArgs = (raw: string): unknown => {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens" };

type Choice = { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null };

function fromChoice(c: Choice | undefined): LlmMessage {
  const content: ContentBlock[] = [];
  if (c?.message?.content) content.push({ type: "text", text: c.message.content });
  const calls = c?.message?.tool_calls ?? [];
  calls.forEach((t, i) => content.push({ type: "tool_use", id: t.id || `call_${i}`, name: t.function?.name ?? "", input: parseArgs(t.function?.arguments ?? "") }));
  // Some servers report "stop" even when they asked for tools: what was asked for decides, not the label.
  return { content, stop_reason: calls.length ? "tool_use" : STOP[c?.finish_reason ?? ""] ?? c?.finish_reason ?? "end_turn" };
}

/** Plain http is only acceptable to this machine or a private network; anything else must be https. */
export function checkBaseUrl(raw: string, allowInsecure = false): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`The base URL "${raw}" is not a valid URL.`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("The base URL must start with https:// (or http:// for a server on this machine or your own network).");
  if (u.protocol === "http:" && !allowInsecure) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const n = ipToInt(host);
    const local = host === "localhost" || host.endsWith(".localhost") || host === "::1"
      || (n !== null && (n >>> 24 === 127 || n >>> 24 === 10 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8));
    if (!local) throw new Error("The base URL uses plain http to a host that is not on this machine or a private network, which would send your data unencrypted. Use https, or set LLM_ALLOW_INSECURE_HTTP=1 if you accept that.");
  }
  return u;
}

export type OpenAiOptions = { baseUrl: string; apiKey?: string; allowInsecure?: boolean; fetchImpl?: typeof fetch; headers?: Record<string, string> };

async function fail(res: Response): Promise<never> {
  const body = redactSecrets((await res.text().catch(() => "")).replace(/\s+/g, " ")).slice(0, 240);
  throw new LlmHttpError(`The AI model provider answered ${res.status}${body ? `: ${body}` : ""}`, res.status);
}

export function openAiClient(o: OpenAiOptions): MessagesClient {
  const base = checkBaseUrl(o.baseUrl, o.allowInsecure);
  const url = `${base.toString().replace(/\/+$/, "")}/chat/completions`;
  const doFetch = o.fetchImpl ?? fetch;
  const send = (p: CreateParams, stream: boolean, signal?: AbortSignal) => doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(stream ? { Accept: "text/event-stream" } : {}), ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}), ...(o.headers ?? {}) },
    body: JSON.stringify({
      model: p.model,
      max_tokens: p.max_tokens,
      messages: toWire(p.system, p.messages),
      ...(p.tools?.length ? { tools: p.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } })) } : {}),
      ...(stream ? { stream: true } : {}),
    }),
    redirect: "error",
    signal,
  });

  return {
    messages: {
      async create(p) {
        const res = await send(p, false);
        if (!res.ok) await fail(res);
        const j = (await res.json().catch(() => null)) as { choices?: Choice[] } | null;
        if (!j?.choices?.length) throw new LlmHttpError("The AI model provider returned no answer.");
        return fromChoice(j.choices[0]);
      },
      stream(p): StreamLike {
        const ac = new AbortController();
        let listener: ((d: string) => void) | null = null;
        const done = (async (): Promise<LlmMessage> => {
          const res = await send(p, true, ac.signal);
          if (!res.ok) await fail(res);
          if (!res.body) throw new LlmHttpError("The AI model provider returned no stream.");
          let text = "";
          let finish: string | null = null;
          const calls: { id: string; name: string; args: string }[] = [];
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          const line = (l: string) => {
            if (!l.startsWith("data:")) return;
            const data = l.slice(5).trim();
            if (!data || data === "[DONE]") return;
            let j: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
            try { j = JSON.parse(data); } catch { return; }
            const ch = j.choices?.[0];
            if (!ch) return;
            if (ch.delta?.content) { text += ch.delta.content; listener?.(ch.delta.content); }
            for (const t of ch.delta?.tool_calls ?? []) {
              const c = (calls[t.index ?? 0] ??= { id: "", name: "", args: "" });
              if (t.id) c.id = t.id;
              if (t.function?.name) c.name += t.function.name;
              if (t.function?.arguments) c.args += t.function.arguments;
            }
            if (ch.finish_reason) finish = ch.finish_reason;
          };
          for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) { line(buf.slice(0, nl).replace(/\r$/, "")); buf = buf.slice(nl + 1); }
          }
          if (buf.trim()) line(buf.trim());
          return fromChoice({ message: { content: text, tool_calls: calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })) }, finish_reason: finish });
        })();
        // A stream nobody awaited yet must not be reported as an unhandled rejection; finalMessage() still throws it.
        done.catch(() => undefined);
        return {
          on(_event, l) { listener = l; return undefined; },
          finalMessage: () => done,
          abort: () => ac.abort(),
        };
      },
    },
  };
}
