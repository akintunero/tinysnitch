/**
 * The one place that talks to the CML MCP server. Connects over stdio or Streamable HTTP, discovers
 * tools dynamically, validates arguments against each tool's own schema, enforces timeouts and an
 * output cap, and reports an honest connection state. It never pretends a call succeeded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Classification, classifyTool } from "./classify";
import { type ArgValidator, makeValidator } from "./validate";
import { redactSecrets } from "../security/redact";
import type { McpConfig } from "../config";

export type McpStatus = "disconnected" | "connecting" | "connected" | "error";

export type ToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
  classification: Classification;
};

export type ToolResult = {
  ok: boolean;
  text: string;
  truncated: boolean;
  durationMs: number;
};

export type McpLogEntry = { at: string; op: string; tool?: string; ok: boolean; ms?: number; detail?: string };

export type McpHealth = {
  status: McpStatus;
  transport: McpConfig["transport"] | "custom";
  toolCount: number;
  server?: { name: string; version: string };
  lastAttempt?: string;
  lastError?: string;
};

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: "not_connected" | "unknown_tool" | "invalid_arguments" | "timeout" | "tool_error" | "transport",
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type McpServiceOptions = {
  /** Per-request timeout. Network devices can be slow; default 60 s. */
  timeoutMs?: number;
  /** Tool output is cut at this many characters before it reaches Claude or the UI. */
  maxOutputChars?: number;
  onLog?: (e: McpLogEntry) => void;
  /** Tests inject an in-process transport here. */
  transportFactory?: () => Transport;
};

export class McpService {
  private client: Client | null = null;
  private toolList: ToolInfo[] = [];
  private validators = new Map<string, ArgValidator>();
  private state: McpHealth;
  private connecting: Promise<void> | null = null;
  private stderrTail = "";
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(private readonly config: McpConfig | null, private readonly opts: McpServiceOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxOutputChars = opts.maxOutputChars ?? 60_000;
    this.state = {
      status: "disconnected",
      transport: opts.transportFactory ? "custom" : (config?.transport ?? "stdio"),
      toolCount: 0,
    };
  }

  health(): McpHealth {
    return { ...this.state };
  }

  tools(): ToolInfo[] {
    return [...this.toolList];
  }

  private log(e: Omit<McpLogEntry, "at">) {
    this.opts.onLog?.({ at: new Date().toISOString(), ...e });
  }

  private makeTransport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory();
    const c = this.config;
    if (!c) throw new McpError("The CML MCP connection is not configured.", "not_connected");
    if (c.transport === "stdio") {
      // Only a safe default set plus the variables the user listed reach the server process.
      const t = new StdioClientTransport({
        command: c.command,
        args: c.args,
        env: { ...getDefaultEnvironment(), ...c.env },
        stderr: "pipe",
      });
      // Always drain stderr: an unread pipe eventually blocks the child. Keep a short tail for diagnosis.
      this.stderrTail = "";
      t.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-1500);
      });
      return t;
    }
    return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } });
  }

  connect(): Promise<void> {
    if (this.state.status === "connected") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.state = { ...this.state, status: "connecting", lastAttempt: new Date().toISOString(), lastError: undefined };
    const client = new Client({ name: "tiny-snitch", version: "0.1.0" });
    try {
      await client.connect(this.makeTransport(), { timeout: this.timeoutMs });
      client.onclose = () => {
        if (this.client === client) {
          this.client = null;
          this.state = { ...this.state, status: "error", lastError: "The MCP connection closed." };
          this.log({ op: "close", ok: false });
        }
      };
      this.client = client;
      const v = client.getServerVersion();
      this.state = { ...this.state, status: "connected", server: v ? { name: v.name, version: v.version } : undefined };
      await this.refreshTools();
      this.log({ op: "connect", ok: true });
    } catch (e) {
      const tail = redactSecrets(this.stderrTail.trim().split(/\r?\n/).slice(-6).join(" | ")).slice(-500);
      const message = `${describeError(e)}${tail ? ` (server said: ${tail})` : ""}`;
      this.client = null;
      await client.close().catch(() => undefined);
      this.state = { ...this.state, status: "error", lastError: message, toolCount: 0 };
      this.log({ op: "connect", ok: false, detail: message });
      throw new McpError(`Could not connect to the CML MCP server: ${message}`, "transport");
    }
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.toolList = [];
    this.validators.clear();
    this.state = { ...this.state, status: "disconnected", toolCount: 0 };
    await c?.close().catch(() => undefined);
    this.log({ op: "disconnect", ok: true });
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /** Discovery is dynamic: nothing about tool names or arguments is assumed. */
  async refreshTools(): Promise<ToolInfo[]> {
    const client = this.requireClient();
    const found: ToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeoutMs });
      for (const t of page.tools) {
        found.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          annotations: t.annotations ?? null,
          classification: classifyTool({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          }),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.toolList = found;
    this.validators = new Map(found.map((t) => [t.name, makeValidator(t.inputSchema)]));
    this.state = { ...this.state, toolCount: found.length };
    return this.tools();
  }

  private requireClient(): Client {
    if (!this.client) throw new McpError("Not connected to the CML MCP server.", "not_connected");
    return this.client;
  }

  /** Validates the call against the discovered schema, then executes it on the server. */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.toolList.find((t) => t.name === name);
    if (!tool) throw new McpError(`The server has no tool named "${name}".`, "unknown_tool");
    const checked = this.validators.get(name)?.(args ?? {});
    if (checked && !checked.ok) {
      throw new McpError(`Invalid arguments for ${name}: ${checked.errors.join("; ")}`, "invalid_arguments");
    }
    const client = this.requireClient();
    const started = Date.now();
    try {
      const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
        timeout: this.timeoutMs,
      });
      const content = Array.isArray(res.content) ? res.content : [];
      let text = content
        .map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" ? String((c as { text: unknown }).text) : `[${(c as { type?: string }).type ?? "unknown"} content omitted]`))
        .join("\n");
      if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
      const truncated = text.length > this.maxOutputChars;
      if (truncated) text = `${text.slice(0, this.maxOutputChars)}\n[output truncated at ${this.maxOutputChars} characters]`;
      const ms = Date.now() - started;
      const ok = res.isError !== true;
      this.log({ op: "call", tool: name, ok, ms });
      return { ok, text, truncated, durationMs: ms };
    } catch (e) {
      const ms = Date.now() - started;
      const message = describeError(e);
      this.log({ op: "call", tool: name, ok: false, ms, detail: message });
      if (/timed out|timeout/i.test(message)) throw new McpError(`${name} timed out after ${this.timeoutMs} ms.`, "timeout");
      throw new McpError(`${name} failed: ${message}`, "tool_error");
    }
  }
}

export function describeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 400);
}
