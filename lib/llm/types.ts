/**
 * What Tiny Snitch needs from an AI model, and nothing provider-specific. The shapes are the common denominator of the
 * tool-use APIs (text, a tool request, a tool result); each provider adapter translates to and from its own wire format.
 * Everything else (the tool loop, masking, history, "Explain findings") is written against these types only.
 */
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string | { type: "text"; text: string }[]; is_error?: boolean };

export type ContentBlock = TextBlock | ToolUseBlock;
export type MessageParam = { role: "user" | "assistant"; content: string | (TextBlock | ToolUseBlock | ToolResultBlock)[] };

export type LlmTool = { name: string; description?: string; input_schema: { type: "object"; [k: string]: unknown } };

export type CreateParams = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: LlmTool[];
};

/** What a model answers. `stop_reason` is "tool_use" when it wants tools run, "end_turn" when it is done, "max_tokens" when it was cut off. */
export type LlmMessage = {
  /** A provider may return block kinds this app does not use (thinking, citations); they are kept as they came and ignored. */
  content: (ContentBlock | { type: string })[];
  stop_reason: string | null;
};

export const isText = (b: { type: string }): b is TextBlock => b.type === "text" && typeof (b as TextBlock).text === "string";
export const isToolUse = (b: { type: string }): b is ToolUseBlock => b.type === "tool_use";

export type StreamLike = {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<LlmMessage>;
  abort(): void;
};

/** The one interface a provider adapter implements. `stream` is optional: without it the answer arrives whole. */
export type MessagesClient = {
  messages: {
    create: (p: CreateParams) => Promise<LlmMessage>;
    stream?: (p: CreateParams) => StreamLike;
  };
};

/** A failed request to a model provider. `status` is the HTTP status, when there was one. */
export class LlmHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmHttpError";
  }
}
