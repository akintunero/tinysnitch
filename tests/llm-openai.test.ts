import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, describeLlm, loadLlmConfig } from "@/lib/config";
import { createLlmClient } from "@/lib/llm";
import { checkBaseUrl, openAiClient, toWire } from "@/lib/llm/openai";
import { describeApiError, runToolLoop } from "@/lib/llm/loop";
import { type MessageParam } from "@/lib/llm/types";
import { pseudonymisingClient } from "@/lib/privacy/client";
import { Pseudonymiser } from "@/lib/privacy/pseudonym";

type Seen = { url: string; auth: string | undefined; body: Record<string, unknown> };
type Reply = { status?: number; json?: unknown; sse?: string[]; headers?: Record<string, string> };

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

/** A server that speaks the OpenAI chat-completions format, replaying the scripted replies in order. */
async function fake(replies: Reply[]): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
      const r = replies.shift() ?? { status: 500, json: { error: "no more replies" } };
      if (r.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const part of r.sse) res.write(part);
        res.end();
      } else {
        res.writeHead(r.status ?? 200, { "Content-Type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.json ?? {}));
      }
    });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, seen };
}

const answer = (message: Record<string, unknown>, finish = "stop") => ({ json: { choices: [{ message, finish_reason: finish }] } });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const sse = (...chunks: unknown[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

describe("translating to the chat-completions format", () => {
  it("puts the system prompt first, and turns tool requests and results into tool_calls and tool messages", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "show me R1" },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "run_command", input: { cmd: "show version" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "IOS 15.9" }, { type: "text", text: "and then?" }] },
    ];
    expect(toWire("be careful", messages)).toEqual([
      { role: "system", content: "be careful" },
      { role: "user", content: "show me R1" },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "t1", type: "function", function: { name: "run_command", arguments: "{\"cmd\":\"show version\"}" } }] },
      { role: "tool", tool_call_id: "t1", content: "IOS 15.9" },
      { role: "user", content: "and then?" },
    ]);
  });

  it("sends null content for an assistant turn that only asked for tools, and joins block-style results", () => {
    const w = toWire(undefined, [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }] },
    ]);
    expect(w[0]).toMatchObject({ role: "assistant", content: null });
    expect(w[1]).toEqual({ role: "tool", tool_call_id: "a", content: "one\ntwo" });
  });
});

describe("the OpenAI-compatible client", () => {
  it("sends the model, tools and key, and reads text back", async () => {
    const { base, seen } = await fake([answer({ content: "hello" })]);
    const c = openAiClient({ baseUrl: base, apiKey: "sk-test-123" });
    const r = await c.messages.create({ model: "m1", max_tokens: 50, system: "sys", messages: [{ role: "user", content: "hi" }], tools: [{ name: "get_topology", description: "d", input_schema: { type: "object", properties: {} } }] });
    expect(r).toEqual({ content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" });
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].auth).toBe("Bearer sk-test-123");
    expect(seen[0].body).toMatchObject({ model: "m1", max_tokens: 50, tools: [{ type: "function", function: { name: "get_topology", parameters: { type: "object" } } }] });
  });

  it("sends no Authorization header when there is no key (a local model)", async () => {
    const { base, seen } = await fake([answer({ content: "ok" })]);
    await openAiClient({ baseUrl: base }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(seen[0].auth).toBeUndefined();
    expect(seen[0].body).not.toHaveProperty("tools");
  });

  it("turns tool calls into tool_use blocks, whatever finish reason the server gives", async () => {
    const { base } = await fake([answer({ content: null, tool_calls: [call("c1", "run_command", { cmd: "show ip route" })] }, "stop")]);
    const r = await openAiClient({ baseUrl: base }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content).toEqual([{ type: "tool_use", id: "c1", name: "run_command", input: { cmd: "show ip route" } }]);
  });

  it("does not trust arguments that are not JSON: the tool gets an empty input and says what is missing", async () => {
    const { base } = await fake([answer({ tool_calls: [call("c1", "t", "{not json")] }, "tool_calls")]);
    const r = await openAiClient({ baseUrl: base }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(r.content).toEqual([{ type: "tool_use", id: "c1", name: "t", input: {} }]);
  });

  it("maps a cut-off answer to max_tokens", async () => {
    const { base } = await fake([answer({ content: "partial" }, "length")]);
    expect((await openAiClient({ baseUrl: base }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })).stop_reason).toBe("max_tokens");
  });

  it("streams text as it arrives and assembles a tool call that was split across chunks", async () => {
    const { base } = await fake([{ sse: sse(
      delta({ content: "Let me " }),
      delta({ content: "check." }),
      delta({ tool_calls: [{ index: 0, id: "c9", function: { name: "run_com", arguments: "{\"cmd\":" } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: "mand", arguments: "\"show clock\"}" } }] }),
      delta({}, "tool_calls"),
    ) }]);
    const got: string[] = [];
    const s = openAiClient({ baseUrl: base }).messages.stream!({ model: "m", max_tokens: 9, messages: [{ role: "user", content: "x" }] });
    s.on("text", (d) => got.push(d));
    const r = await s.finalMessage();
    expect(got).toEqual(["Let me ", "check."]);
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content).toEqual([{ type: "text", text: "Let me check." }, { type: "tool_use", id: "c9", name: "run_command", input: { cmd: "show clock" } }]);
  });

  it("copes with a stream cut into arbitrary pieces", async () => {
    const whole = sse(delta({ content: "abc" }), delta({}, "stop")).join("");
    const { base } = await fake([{ sse: [whole.slice(0, 7), whole.slice(7, 30), whole.slice(30)] }]);
    const s = openAiClient({ baseUrl: base }).messages.stream!({ model: "m", max_tokens: 9, messages: [{ role: "user", content: "x" }] });
    expect((await s.finalMessage()).content).toEqual([{ type: "text", text: "abc" }]);
  });

  it("reports a provider error with its status and no secret", async () => {
    const { base } = await fake([{ status: 401, json: { error: { message: "bad key sk-live-abcdefghijklmnop" } } }]);
    const err = await openAiClient({ baseUrl: base, apiKey: "k" }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] }).catch((e: Error) => e);
    expect((err as { status?: number }).status).toBe(401);
    expect(describeApiError(err)).toBe("The AI model provider rejected the API key (401). Check the API key setting.");
    expect((err as Error).message).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("does not follow a redirect, which could carry the key somewhere else", async () => {
    const { base, seen } = await fake([{ status: 302, headers: { Location: "/elsewhere" }, json: {} }, answer({ content: "would have worked" })]);
    await expect(openAiClient({ baseUrl: base, apiKey: "k" }).messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
    expect(seen).toHaveLength(1); // the second address was never asked
  });

  it("stops a stream when asked", async () => {
    const { base } = await fake([{ sse: sse(delta({ content: "a" })) }]);
    const s = openAiClient({ baseUrl: base }).messages.stream!({ model: "m", max_tokens: 9, messages: [{ role: "user", content: "x" }] });
    s.abort();
    await expect(s.finalMessage()).rejects.toThrow();
  });
});

describe("the tool loop with a provider that is not Anthropic", () => {
  it("runs a tool the model asked for and sends its output back as a tool message", async () => {
    const { base, seen } = await fake([
      answer({ content: null, tool_calls: [call("c1", "get_topology", {})] }, "tool_calls"),
      answer({ content: "R1 and R2 are up." }),
    ]);
    const out = await runToolLoop({
      client: openAiClient({ baseUrl: base }),
      model: "m",
      messages: [{ role: "user", content: "what is up?" }],
      tools: [{ name: "get_topology", description: "d", inputSchema: { type: "object", properties: {} } }],
      execute: async () => ({ content: "R1, R2", isError: false }),
    });
    expect(out.text).toBe("R1 and R2 are up.");
    expect(out.toolCalls).toBe(1);
    const second = seen[1].body.messages as { role: string; tool_call_id?: string; content: string }[];
    const tool = second.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toBe("c1");
    expect(tool.content).toContain("R1, R2");
    expect(tool.content).toContain("untrusted=\"true\""); // device output still travels wrapped as data
  });

  it("masks identifying data on the way out and restores it on the way back", async () => {
    const { base, seen } = await fake([answer({ content: "dev-placeholder is fine" })]);
    const p = new Pseudonymiser({ devices: ["lon-core1"] });
    const client = pseudonymisingClient(openAiClient({ baseUrl: base }), p);
    const r = await client.messages.create({ model: "m", max_tokens: 9, messages: [{ role: "user", content: "check lon-core1 at 203.0.113.77" }] });
    const sent = JSON.stringify(seen[0].body);
    expect(sent).not.toContain("lon-core1");
    expect(sent).not.toContain("203.0.113.77");
    expect(r.content).toBeTruthy();
  });
});

describe("where a request may go", () => {
  it("accepts https anywhere, and plain http only to this machine or a private network", () => {
    expect(() => checkBaseUrl("https://api.example.com/v1")).not.toThrow();
    for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://10.1.2.3/v1", "http://192.168.0.5:1234/v1", "http://172.16.4.4/v1", "http://[::1]:8080/v1"]) expect(() => checkBaseUrl(ok), ok).not.toThrow();
    for (const bad of ["http://api.example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://llm.internal/v1"]) expect(() => checkBaseUrl(bad), bad).toThrow(/unencrypted/);
  });

  it("lets someone accept plain http to a remote host on purpose", () => {
    expect(() => checkBaseUrl("http://llm.internal/v1", true)).not.toThrow();
  });

  it("refuses anything that is not http or https, and junk", () => {
    expect(() => checkBaseUrl("ftp://x/v1")).toThrow(/https/);
    expect(() => checkBaseUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("choosing a provider from the environment", () => {
  it("defaults to Anthropic with the variables that always worked", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m" })).toMatchObject({ provider: "anthropic", apiKey: "k", model: "m", baseUrl: undefined });
    expect(() => loadLlmConfig({})).toThrow(/Missing ANTHROPIC_API_KEY and ANTHROPIC_MODEL/);
  });

  it("takes LLM_* over the Anthropic names, and a base URL for a compatible gateway", () => {
    expect(loadLlmConfig({ LLM_API_KEY: "a", LLM_MODEL: "b", ANTHROPIC_API_KEY: "x", ANTHROPIC_MODEL: "y", LLM_BASE_URL: "https://gw.example/v1" })).toMatchObject({ provider: "anthropic", apiKey: "a", model: "b", baseUrl: "https://gw.example/v1" });
  });

  it("configures an OpenAI-compatible server, where the key is optional", () => {
    expect(loadLlmConfig({ LLM_PROVIDER: "openai", LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama3.1" })).toMatchObject({ provider: "openai", model: "llama3.1", apiKey: undefined });
    expect(loadLlmConfig({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "https://x/v1", LLM_MODEL: "m", OPENAI_API_KEY: "k" }).apiKey).toBe("k");
  });

  it("names what is missing, and refuses an unknown provider", () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: "openai" })).toThrow(/LLM_BASE_URL and LLM_MODEL/);
    expect(() => loadLlmConfig({ LLM_PROVIDER: "gemini" })).toThrow(ConfigError);
  });

  it("describes where requests go without a key, and builds the right client", () => {
    const c = loadLlmConfig({ LLM_PROVIDER: "openai", LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "m", LLM_API_KEY: "secret" });
    expect(describeLlm(c)).toBe("OpenAI-compatible server at http://localhost:11434/v1");
    expect(describeLlm(c)).not.toContain("secret");
    expect(createLlmClient(c).messages.stream).toBeTypeOf("function");
    expect(() => createLlmClient({ ...c, baseUrl: "http://example.com/v1" })).toThrow(/unencrypted/);
  });
});
