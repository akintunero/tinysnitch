import Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./types";

/**
 * Anthropic's API. The SDK already speaks the shapes in `types.ts`, so this only builds the client. A `baseUrl` points it
 * at a gateway that accepts the same request format.
 */
export function anthropicClient(o: { apiKey: string; baseUrl?: string }): MessagesClient {
  return new Anthropic({ apiKey: o.apiKey, ...(o.baseUrl ? { baseURL: o.baseUrl } : {}) }) as unknown as MessagesClient;
}
