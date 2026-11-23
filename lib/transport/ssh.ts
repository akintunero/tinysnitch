import { createHash } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { resolveSecret } from "../core/secrets";
import { DEVICE_ERROR, blockedLines } from "../core/safety";
import type { CommandOutcome, DeviceRef, DeviceTransport, Platform, PushOptions, PushOutcome } from "../core/types";
import { checkReadOnlyCommand } from "../assistant/policy";
import { redactSecrets } from "../security/redact";

/** Per-dialect CLI facts. Only dialects with an entry can be pushed to. */
export const CLI: Record<Platform, { pagerOff: string[]; configEnter: string | null; configExit: string; save: string | null }> = {
  ios: { pagerOff: ["terminal length 0", "terminal width 0"], configEnter: "configure terminal", configExit: "end", save: "write memory" },
  nxos: { pagerOff: ["terminal length 0", "terminal width 511"], configEnter: "configure terminal", configExit: "end", save: "copy running-config startup-config" },
  eos: { pagerOff: ["terminal length 0", "terminal width 32767"], configEnter: "configure terminal", configExit: "end", save: "write memory" },
  junos: { pagerOff: ["set cli screen-length 0", "set cli screen-width 1000"], configEnter: null, configExit: "exit", save: null },
  unknown: { pagerOff: [], configEnter: null, configExit: "end", save: null },
};

export type SshTarget = {
  label: string;
  host: string;
  port: number;
  username: string;
  /** Secret references, resolved only when connecting. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  enablePassword?: string;
  /** Pinned `SHA256:` fingerprint. Without one, the first key seen is remembered and any change is refused. */
  hostKey?: string;
  jump?: SshTarget;
};

export interface HostKeyStore {
  get(id: string): string | null;
  set(id: string, fingerprint: string): void;
}

export class SshError extends Error {
  constructor(message: string, readonly code: "auth" | "hostkey" | "timeout" | "unreachable" | "io" | "config") {
    super(message);
    this.name = "SshError";
  }
}

export const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>()][A-Za-z0-9]?/g; // eslint-disable-line no-control-regex
const PROMPT_TAIL = /(?:^|\n)[^\s\n][^\n]{0,80}[#>$]\s?$/;
const MORE = /--\s?More\s?--|<--- More --->/i;

const clean = (s: string) => s.replace(ANSI, "").replace(/\r/g, "").replace(/\x08+/g, "").replace(/\x00/g, ""); // eslint-disable-line no-control-regex

type Opts = {
  hostKeys: HostKeyStore;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleMs?: number;
  env?: Record<string, string | undefined>;
};

/** A logged-in CLI on one device. Commands on it run strictly one at a time. */
export class Session {
  private client: Client | null = null;
  private jumpClient: Client | null = null;
  private stream: ClientChannel | null = null;
  private buf = "";
  private waiters: (() => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  prompt = "";
  closed = false;

  constructor(private t: SshTarget, private platform: Platform, private o: Required<Pick<Opts, "connectTimeoutMs" | "commandTimeoutMs" | "idleMs">> & Opts) {}

  private cfg(t: SshTarget, sock?: NodeJS.ReadableStream): ConnectConfig {
    const env: Record<string, string | undefined> = this.o.env ?? process.env;
    let password: string | undefined, privateKey: string | undefined, passphrase: string | undefined;
    try {
      if (t.password) password = resolveSecret(t.password, env);
      if (t.privateKey) privateKey = resolveSecret(t.privateKey.replace(/^file:/, "file:"), env);
      if (t.passphrase) passphrase = resolveSecret(t.passphrase, env);
    } catch (e) {
      throw new SshError(e instanceof Error ? e.message : "A credential could not be read.", "config");
    }
    const id = `${t.host}:${t.port}`;
    return {
      host: t.host, port: t.port, username: t.username, password, privateKey, passphrase, sock: sock as never,
      readyTimeout: this.o.connectTimeoutMs, keepaliveInterval: 15_000, tryKeyboard: !!password,
      // ssh2's modern defaults only. Old IOS images need the legacy set; that is an explicit choice (TS_SSH_LEGACY_ALGORITHMS=1),
      // because it allows SHA-1 key exchange and CBC ciphers.
      ...((this.o.env ?? process.env).TS_SSH_LEGACY_ALGORITHMS === "1"
        ? { algorithms: { kex: { append: ["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1", "diffie-hellman-group1-sha1"] }, serverHostKey: { append: ["ssh-rsa", "ssh-dss"] }, cipher: { append: ["aes128-cbc", "aes256-cbc", "3des-cbc"] } } as unknown as ConnectConfig["algorithms"] }
        : {}),
      hostVerifier: (key: Buffer) => {
        const fp = fingerprint(key);
        if (t.hostKey) {
          if (t.hostKey !== fp) throw new SshError(`${t.label}: the SSH host key does not match the pinned fingerprint (saw ${fp}). Refusing to connect.`, "hostkey");
          return true;
        }
        const known = this.o.hostKeys.get(id);
        if (known && known !== fp) throw new SshError(`${t.label}: the SSH host key changed (was ${known}, now ${fp}). Refusing to connect; if the device was replaced, remove the remembered key.`, "hostkey");
        if (!known) this.o.hostKeys.set(id, fp);
        return true;
      },
    };
  }

  private open(t: SshTarget, sock?: NodeJS.ReadableStream): Promise<Client> {
    return new Promise((resolve, reject) => {
      const c = new Client();
      let settled = false;
      const fail = (e: Error) => { if (!settled) { settled = true; try { c.end(); } catch { /* already closed */ } reject(e); } };
      c.on("ready", () => { if (!settled) { settled = true; resolve(c); } });
      c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
        try { finish(prompts.map(() => (t.password ? resolveSecret(t.password, this.o.env ?? process.env) : ""))); } catch { finish([]); }
      });
      c.on("error", (e: Error & { level?: string }) => {
        if (e instanceof SshError) return fail(e);
        const m = e.message || "connection error";
        if (e.level === "client-authentication" || /authentication/i.test(m)) fail(new SshError(`${t.label}: login was refused (check the username and credential).`, "auth"));
        else if (/timed out|ETIMEDOUT/i.test(m)) fail(new SshError(`${t.label}: no answer from ${t.host}:${t.port} (timed out).`, "timeout"));
        else if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(m)) fail(new SshError(`${t.label}: ${t.host}:${t.port} is not reachable (${m.replace(/^.*?(ECONN\w+|EHOST\w+|ENET\w+|ENOTFOUND|EAI_\w+).*$/, "$1")}).`, "unreachable"));
        else fail(new SshError(`${t.label}: SSH error: ${m.slice(0, 160)}`, "io"));
      });
      try {
        c.connect(this.cfg(t, sock));
      } catch (e) {
        fail(e instanceof SshError ? e : new SshError(`${t.label}: ${e instanceof Error ? e.message : "could not start the connection"}`, "io"));
      }
    });
  }

  /** Logs in (through the jump host if there is one) and returns the SSH client without opening a CLI. */
  async connectClient(): Promise<Client> {
    let sock: NodeJS.ReadableStream | undefined;
    if (this.t.jump) {
      this.jumpClient = await this.open(this.t.jump);
      sock = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
        this.jumpClient!.forwardOut("127.0.0.1", 0, this.t.host, this.t.port, (err, s) => (err ? reject(new SshError(`${this.t.label}: the jump host could not reach ${this.t.host}:${this.t.port}.`, "unreachable")) : resolve(s))),
      );
    }
    this.client = await this.open(this.t, sock);
    this.client.on("close", () => this.dispose());
    return this.client;
  }

  async connect(): Promise<void> {
    await this.connectClient();
    this.stream = await new Promise<ClientChannel>((resolve, reject) =>
      this.client!.shell({ term: "vt100", rows: 0, cols: 200 }, (err, s) => (err ? reject(new SshError(`${this.t.label}: could not open a CLI session.`, "io")) : resolve(s))),
    );
    this.stream.on("data", (d: Buffer) => { this.buf += d.toString("utf8"); this.wake(); });
    this.stream.on("close", () => this.dispose());
    await this.settle(this.o.connectTimeoutMs);
    let first = clean(this.buf);
    if (/^\s*(password|username|login)\s*:\s*$/im.test(first.split("\n").pop() ?? "")) throw new SshError(`${this.t.label}: the device asked for a second login, which is not supported.`, "auth");
    this.prompt = this.lastLine(first);
    if (!/[#>$]\s?$/.test(this.prompt)) throw new SshError(`${this.t.label}: connected, but no CLI prompt appeared.`, "io");
    if (this.prompt.endsWith(">") && this.t.enablePassword) await this.enable();
    for (const c of CLI[this.platform].pagerOff) await this.exec(c);
  }

  private async enable(): Promise<void> {
    this.buf = "";
    this.stream!.write("enable\n");
    await this.until(/[Pp]assword:\s?$/, 8_000, true);
    this.buf = "";
    this.stream!.write(`${resolveSecret(this.t.enablePassword!, this.o.env ?? process.env)}\n`);
    await this.untilPrompt(8_000);
    this.prompt = this.lastLine(clean(this.buf));
    if (this.prompt.endsWith(">")) throw new SshError(`${this.t.label}: enable was refused (check the enable credential).`, "auth");
  }

  private lastLine(s: string): string {
    return (s.split("\n").filter((l) => l.trim()).pop() ?? "").trim();
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves once output has stopped for a moment, or at the deadline. */
  private settle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      let timer: NodeJS.Timeout;
      const check = () => {
        clearTimeout(timer);
        if (Date.now() >= deadline) return resolve();
        timer = setTimeout(() => { if (this.buf.length) resolve(); else check(); }, 400);
        this.waiters.push(check);
      };
      check();
    });
  }

  private until(re: RegExp, ms: number, raw = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { done(); reject(new SshError(`${this.t.label}: the device did not answer within ${Math.round(ms / 1000)} s.`, "timeout")); }, ms);
      const check = () => {
        if (this.closed) { done(); return reject(new SshError(`${this.t.label}: the connection closed.`, "io")); }
        const text = raw ? this.buf : clean(this.buf);
        if (MORE.test(text.slice(-40))) { this.stream?.write(" "); this.buf = this.buf.replace(MORE, ""); }
        if (re.test(clean(this.buf))) { done(); resolve(); } else this.waiters.push(check);
      };
      const done = () => clearTimeout(t);
      check();
    });
  }

  private untilPrompt(ms: number): Promise<void> {
    return this.until(PROMPT_TAIL, ms);
  }

  /** Sends one line and returns what the device printed for it, without the echo or the next prompt. */
  private async exec(line: string, ms = this.o.commandTimeoutMs): Promise<string> {
    if (!this.stream || this.closed) throw new SshError(`${this.t.label}: the connection closed.`, "io");
    this.buf = "";
    this.stream.write(`${line}\n`);
    await this.untilPrompt(ms);
    const lines = clean(this.buf).split("\n");
    if (lines[0]?.trim().endsWith(line.trim()) || lines[0]?.includes(line.trim())) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const last = lines.pop(); // the prompt that ended this command
    if (last !== undefined && !PROMPT_TAIL.test(`\n${last}`)) lines.push(last);
    else if (last !== undefined) this.prompt = last.trim();
    return lines.join("\n");
  }

  /** Runs `fn` after everything already queued on this session, and keeps the session alive while it works. */
  enqueue<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const run = this.tail.then(() => fn(this));
    this.tail = run.catch(() => undefined).finally(() => {
      this.idleTimer = setTimeout(() => this.close(), this.o.idleMs);
      this.idleTimer.unref?.();
    });
    return run;
  }

  async command(line: string, ms?: number): Promise<string> {
    return this.exec(line, ms);
  }

  async config(lines: string[]): Promise<PushOutcome> {
    const cli = CLI[this.platform];
    if (!cli.configEnter) return { ok: false, text: `Configuration changes are not supported for ${this.platform} devices.`, applied: [], failedAt: null };
    const transcript: string[] = [];
    const applied: string[] = [];
    let failedAt: string | null = null;
    const enter = await this.exec(cli.configEnter);
    transcript.push(`${cli.configEnter}\n${enter}`.trim());
    if (DEVICE_ERROR.test(enter)) return { ok: false, text: transcript.join("\n"), applied, failedAt: cli.configEnter };
    try {
      for (const l of lines) {
        const out = await this.exec(l);
        transcript.push(`${l}${out ? `\n${out}` : ""}`);
        if (DEVICE_ERROR.test(out)) { failedAt = l; break; }
        applied.push(l);
      }
    } finally {
      try { await this.exec(cli.configExit); } catch { /* the original error matters more */ }
    }
    return { ok: failedAt === null, text: redactSecrets(transcript.join("\n")), applied, failedAt };
  }

  private dispose() {
    this.closed = true;
    this.wake();
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  close() {
    this.dispose();
    try { this.stream?.end(); } catch { /* closing */ }
    try { this.client?.end(); } catch { /* closing */ }
    try { this.jumpClient?.end(); } catch { /* closing */ }
  }
}

/**
 * SSH access to real devices. One session per device, reused for a minute, never more than a handful open at once.
 * `run` enforces the read-only allowlist itself, so no caller can widen it; `push` refuses blocked commands.
 */
export class SshTransport implements DeviceTransport {
  readonly kind = "ssh" as const;
  private sessions = new Map<string, Session>();
  private opening = new Map<string, Promise<Session>>();
  private active = 0;
  private queue: (() => void)[] = [];
  private o: Required<Pick<Opts, "connectTimeoutMs" | "commandTimeoutMs" | "idleMs">> & Opts;

  constructor(private targetFor: (d: DeviceRef) => SshTarget | null, opts: Opts) {
    this.o = { connectTimeoutMs: 15_000, commandTimeoutMs: 45_000, idleMs: 60_000, ...opts };
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= 8) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.queue.shift()?.(); }
  }

  private async session(d: DeviceRef): Promise<Session> {
    const t = this.targetFor(d);
    if (!t) throw new SshError(`${d.label}: no SSH address or credential is known for this device.`, "config");
    const key = d.id;
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) return existing;
    let p = this.opening.get(key);
    if (!p) {
      p = (async () => {
        const s = new Session(t, d.platform, this.o);
        try { await s.connect(); } catch (e) { s.close(); throw e; }
        this.sessions.set(key, s);
        return s;
      })().finally(() => this.opening.delete(key));
      this.opening.set(key, p);
    }
    return p;
  }

  private fail(e: unknown): CommandOutcome {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }

  async run(device: DeviceRef, command: string): Promise<CommandOutcome> {
    const check = checkReadOnlyCommand(command);
    if (!check.ok) return { ok: false, text: check.reason };
    try {
      return await this.slot(async () => {
        const s = await this.session(device);
        const long = /^(ping|traceroute)/i.test(command.trim());
        const text = await s.enqueue((x) => x.command(command.trim(), long ? 90_000 : undefined));
        return { ok: true, text: redactSecrets(text) };
      });
    } catch (e) {
      return this.fail(e);
    }
  }

  pushSupport(d: DeviceRef) {
    if (CLI[d.platform].configEnter) return { ok: true } as const;
    return { ok: false, reason: d.platform === "junos" ? "Junos changes need a NETCONF connection (transport: netconf), because Junos uses a candidate configuration and a commit" : `configuration changes are not supported for ${d.platform} devices over SSH` } as const;
  }

  async push(device: DeviceRef, commands: string[], _opts?: PushOptions): Promise<PushOutcome> {
    const bad = blockedLines(commands, device.platform);
    if (bad.length) return { ok: false, text: `Refused before sending anything: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}.`, applied: [], failedAt: bad[0].line };
    try {
      return await this.slot(async () => {
        const s = await this.session(device);
        return s.enqueue((x) => x.config(commands));
      });
    } catch (e) {
      return { ok: false, text: this.fail(e).text, applied: [], failedAt: null };
    }
  }

  async save(device: DeviceRef): Promise<CommandOutcome> {
    const cmd = CLI[device.platform].save;
    if (!cmd) return { ok: false, text: `Saving the configuration is not supported for ${device.platform} devices.` };
    try {
      return await this.slot(async () => {
        const s = await this.session(device);
        const text = await s.enqueue((x) => x.command(cmd, 60_000));
        return { ok: !DEVICE_ERROR.test(text), text: redactSecrets(text) };
      });
    } catch (e) {
      return this.fail(e);
    }
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
