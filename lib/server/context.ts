/**
 * Process-wide server state: the database, the MCP service and the Claude client. Kept on globalThis so
 * Next's dev reloads reuse one MCP connection instead of spawning a new child process each time.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describeApiError } from "../anthropic/bridge";
import { ConfigError, type McpConfig, describeMcp, loadAnthropicConfig, loadMcpConfig } from "../config";
import { type Db, openDatabase } from "../database/db";
import { addAudit } from "../database/repo";
import { McpService, describeError } from "../mcp/service";
import { callsAuditedByCaller } from "./audit-scope";

export type ClaudeState = {
  configured: boolean;
  model: string | null;
  configError: string | null;
  verification: "unverified" | "ok" | "error";
  checkedAt: string | null;
  error: string | null;
};

export type Ctx = {
  db: Db;
  mcp: McpService | null;
  mcpConfig: McpConfig | null;
  mcpConfigError: string | null;
  claude: ClaudeState;
  anthropic: Anthropic | null;
  lastConnectAttempt: number;
};

/** Writes connection events and, unless the caller audits it, each tool call to the audit log. */
export function makeMcpLogger(db: Db): NonNullable<ConstructorParameters<typeof McpService>[1]>["onLog"] {
  return (l) => {
    if (l.op === "call") {
      if (callsAuditedByCaller.getStore()) return;
      addAudit(db, { kind: "tool_call", actor: "system", summary: `${l.tool} ${l.ok ? "ok" : "failed"}${l.ms !== undefined ? ` in ${l.ms} ms` : ""}`, data: l.detail ? { detail: l.detail } : undefined });
    } else {
      addAudit(db, { kind: "mcp", summary: `${l.op} ${l.ok ? "ok" : "failed"}`, data: l.detail ? { detail: l.detail } : undefined });
    }
  };
}

const KEY = "__tinySnitchContext";
const g = globalThis as unknown as Record<string, Ctx | undefined>;

function create(): Ctx {
  const db = openDatabase();
  let mcpConfig: McpConfig | null = null;
  let mcpConfigError: string | null = null;
  try {
    mcpConfig = loadMcpConfig();
  } catch (e) {
    mcpConfigError = e instanceof ConfigError ? e.message : describeError(e);
  }
  const mcp = mcpConfig ? new McpService(mcpConfig, { onLog: makeMcpLogger(db) }) : null;

  let anthropic: Anthropic | null = null;
  const claude: ClaudeState = { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null };
  try {
    const c = loadAnthropicConfig();
    anthropic = new Anthropic({ apiKey: c.apiKey });
    claude.configured = true;
    claude.model = c.model;
  } catch (e) {
    claude.configError = e instanceof ConfigError ? e.message : describeError(e);
  }
  return { db, mcp, mcpConfig, mcpConfigError, claude, anthropic, lastConnectAttempt: 0 };
}

export function getContext(): Ctx {
  return (g[KEY] ??= create());
}

/** Tests install their own context here. */
export function setContext(ctx: Ctx | undefined): void {
  g[KEY] = ctx;
}

export function describeEndpoint(ctx: Ctx): string | null {
  return ctx.mcpConfig ? describeMcp(ctx.mcpConfig) : null;
}

/**
 * Starts a connection if there is none, joins one already in progress, and retries a down server at most
 * once every few seconds. `force` skips that pause. With `wait: false` it returns at once, so status
 * reads never block on a slow connection. Failures are recorded in the service's health and the audit log.
 */
export async function connectMcp(force = false, wait = true): Promise<void> {
  const ctx = getContext();
  if (!ctx.mcp) return;
  const state = ctx.mcp.health().status;
  if (state === "connected") return;
  const quiet = (p: Promise<void>) => p.catch(() => undefined);
  if (state === "connecting") {
    if (wait) await quiet(ctx.mcp.connect()); // connect() returns the in-flight attempt
    return;
  }
  if (!force && Date.now() - ctx.lastConnectAttempt < 5_000) return;
  ctx.lastConnectAttempt = Date.now();
  const attempt = quiet(ctx.mcp.connect());
  if (wait) await attempt;
}

export async function verifyClaude(): Promise<ClaudeState> {
  const ctx = getContext();
  const c = ctx.claude;
  c.checkedAt = new Date().toISOString();
  if (!ctx.anthropic || !c.model) {
    c.verification = "error";
    c.error = c.configError ?? "Claude is not configured.";
    return c;
  }
  try {
    await ctx.anthropic.messages.create({ model: c.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] });
    c.verification = "ok";
    c.error = null;
    addAudit(ctx.db, { kind: "claude", summary: `Claude API verified (${c.model})` });
  } catch (e) {
    c.verification = "error";
    c.error = describeApiError(e);
    addAudit(ctx.db, { kind: "claude", summary: `Claude API check failed`, data: { detail: c.error } });
  }
  return c;
}
