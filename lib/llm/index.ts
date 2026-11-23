import type { LlmConfig } from "../config";
import { anthropicClient } from "./anthropic";
import { openAiClient } from "./openai";
import type { MessagesClient } from "./types";

export * from "./types";

/** The client for the configured provider. Everything above this line is the same whichever one answers. */
export function createLlmClient(c: LlmConfig): MessagesClient {
  if (c.provider === "openai") return openAiClient({ baseUrl: c.baseUrl!, apiKey: c.apiKey, allowInsecure: c.allowInsecure });
  return anthropicClient({ apiKey: c.apiKey!, baseUrl: c.baseUrl });
}
