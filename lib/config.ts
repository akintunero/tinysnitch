/** Environment-driven settings. Secrets are read here, on the server, and nowhere else. */

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

export type McpConfig =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; url: string; headers: Record<string, string> };

export type AnthropicConfig = { apiKey: string; model: string };

type Env = Record<string, string | undefined>;

/** A JSON array, or a shell-like string where single or double quotes group words. */
export function splitArgs(raw: string | undefined): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new ConfigError("CML_MCP_ARGS starts with [ but is not valid JSON.", ["CML_MCP_ARGS"]);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      throw new ConfigError("CML_MCP_ARGS must be a JSON array of strings.", ["CML_MCP_ARGS"]);
    }
    return parsed;
  }
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Some MCP launchers (mcp-remote) expand ${VAR} in their own arguments from their environment, which keeps a
 * secret out of the command line. Next.js expands ${VAR} in .env files before we ever see them, so a literal
 * ${CML_AUTH_HEADER} arrives empty. Write {{VAR}} in CML_MCP_ARGS instead; it is turned into ${VAR} here.
 */
export function withEnvReferences(arg: string): string {
  return arg.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, "${$1}");
}

function jsonStringMap(name: string, raw: string | undefined): Record<string, string> {
  const s = (raw ?? "").trim();
  if (!s) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new ConfigError(`${name} must be a JSON object, for example {"KEY":"value"}.`, [name]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${name} must be a JSON object, for example {"KEY":"value"}.`, [name]);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") throw new ConfigError(`${name}.${k} must be a string.`, [name]);
    out[k] = v;
  }
  return out;
}

export function loadMcpConfig(env: Env = process.env): McpConfig {
  const command = env.CML_MCP_COMMAND?.trim();
  const url = env.CML_MCP_URL?.trim();
  let transport = env.CML_MCP_TRANSPORT?.trim().toLowerCase();
  if (transport === "streamable-http" || transport === "streamablehttp") transport = "http";
  if (!transport) {
    // Only infer when it is unambiguous; otherwise make the user say which one.
    if (command && !url) transport = "stdio";
    else if (url && !command) transport = "http";
    else throw new ConfigError("Set CML_MCP_TRANSPORT to stdio or http.", ["CML_MCP_TRANSPORT"]);
  }
  if (transport === "stdio") {
    if (!command) throw new ConfigError("CML_MCP_TRANSPORT=stdio needs CML_MCP_COMMAND.", ["CML_MCP_COMMAND"]);
    return { transport, command, args: splitArgs(env.CML_MCP_ARGS).map(withEnvReferences), env: jsonStringMap("CML_MCP_ENV", env.CML_MCP_ENV) };
  }
  if (transport === "http") {
    if (!url) throw new ConfigError("CML_MCP_TRANSPORT=http needs CML_MCP_URL.", ["CML_MCP_URL"]);
    try {
      new URL(url);
    } catch {
      throw new ConfigError("CML_MCP_URL is not a valid URL.", ["CML_MCP_URL"]);
    }
    return { transport, url, headers: jsonStringMap("CML_MCP_HEADERS", env.CML_MCP_HEADERS) };
  }
  throw new ConfigError(`CML_MCP_TRANSPORT=${transport} is not supported. Use stdio or http.`, ["CML_MCP_TRANSPORT"]);
}

export function loadAnthropicConfig(env: Env = process.env): AnthropicConfig {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const model = env.ANTHROPIC_MODEL?.trim();
  const missing = [!apiKey && "ANTHROPIC_API_KEY", !model && "ANTHROPIC_MODEL"].filter((x): x is string => !!x);
  if (missing.length) throw new ConfigError(`Missing ${missing.join(" and ")}.`, missing);
  return { apiKey: apiKey!, model: model! };
}

const SECRET_FLAG = /(key|token|secret|pass(word)?|auth)/i;

/** Safe to show: values of secret-looking flags are masked. */
export function redactArgs(args: string[]): string[] {
  return args.map((a, i) => {
    const eq = a.match(/^(--?[\w-]+)=(.*)$/);
    if (eq && SECRET_FLAG.test(eq[1])) return `${eq[1]}=***`;
    if (i > 0 && /^--?[\w-]+$/.test(args[i - 1]) && SECRET_FLAG.test(args[i - 1])) return "***";
    return a;
  });
}

/** One line describing the MCP target without secrets (no env or header values). */
export function describeMcp(c: McpConfig): string {
  if (c.transport === "stdio") {
    return `stdio: ${c.command} ${redactArgs(c.args).join(" ")}`.trim() + ` (env vars: ${Object.keys(c.env).join(", ") || "none"})`;
  }
  let host = c.url;
  try {
    const u = new URL(c.url);
    host = `${u.origin}${u.pathname}`;
  } catch {
    /* validated earlier */
  }
  return `http: ${host} (headers: ${Object.keys(c.headers).join(", ") || "none"})`;
}
