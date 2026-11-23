import type { ClientChannel } from "ssh2";
import { checkReadOnlyCommand } from "../assistant/policy";
import { blockedLines } from "../core/safety";
import type { CommandOutcome, DeviceRef, DeviceTransport, PushOptions, PushOutcome } from "../core/types";
import { redactSecrets } from "../security/redact";
import { type HostKeyStore, Session, type SshTarget } from "./ssh";

/**
 * NETCONF over SSH (RFC 6241, base:1.0 framing) for Junos. Reads use the `<command>` RPC, so the same read-only
 * allowlist applies as everywhere. A change is loaded into the candidate configuration as `set`/`delete` lines,
 * checked, and committed with "commit confirmed": if Tiny Snitch never confirms (it confirms only after reading the
 * result back), the device reverts the change by itself. Written from Juniper's documented NETCONF; tested against a
 * faithful in-process server, not a real Junos device. Only Junos is supported: other platforms use YANG models
 * that do not fit a line-based change.
 */
const EOM = "]]>]]>";
const CONFIRM_MINUTES = 10;

export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function rpcError(reply: string): string | null {
  const m = reply.match(/<rpc-error>([\s\S]*?)<\/rpc-error>/);
  if (!m) return null;
  const msg = m[1].match(/<error-message[^>]*>([\s\S]*?)<\/error-message>/)?.[1];
  const bad = m[1].match(/<bad-element[^>]*>([\s\S]*?)<\/bad-element>/)?.[1];
  return xmlUnescape(`${msg ?? "The device reported an error."}${bad ? ` (near "${bad.trim()}")` : ""}`).replace(/\s+/g, " ").trim();
}

class NetconfSession {
  private stream: ClientChannel | null = null;
  private buf = "";
  private waiter: (() => void) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private n = 0;
  closed = false;
  private idle: NodeJS.Timeout | null = null;

  constructor(private ssh: Session, private label: string, private timeoutMs: number, private idleMs: number) {}

  async open(): Promise<void> {
    const client = await this.ssh.connectClient();
    this.stream = await new Promise<ClientChannel>((resolve, reject) =>
      client.subsys("netconf", (err, s) => (err ? reject(new Error(`${this.label}: the device did not accept a NETCONF session (is NETCONF enabled on port 830?).`)) : resolve(s))),
    );
    this.stream.on("data", (d: Buffer) => { this.buf += d.toString("utf8"); this.waiter?.(); });
    this.stream.on("close", () => { this.closed = true; this.waiter?.(); });
    await this.read(); // the server's hello
    this.stream.write(`<?xml version="1.0" encoding="UTF-8"?><hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>${EOM}`);
  }

  private read(): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new Error(`${this.label}: the device did not answer within ${Math.round(this.timeoutMs / 1000)} s.`)); }, this.timeoutMs);
      const check = () => {
        const i = this.buf.indexOf(EOM);
        if (i >= 0) { clearTimeout(t); this.waiter = null; const msg = this.buf.slice(0, i); this.buf = this.buf.slice(i + EOM.length); resolve(msg); }
        else if (this.closed) { clearTimeout(t); this.waiter = null; reject(new Error(`${this.label}: the connection closed.`)); }
        else this.waiter = check;
      };
      check();
    });
  }

  /** One RPC at a time on a session; returns the whole reply. */
  rpc(inner: string): Promise<string> {
    if (this.idle) clearTimeout(this.idle);
    const run = this.tail.then(async () => {
      if (!this.stream || this.closed) throw new Error(`${this.label}: the connection closed.`);
      this.stream.write(`<?xml version="1.0" encoding="UTF-8"?><rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${++this.n}">${inner}</rpc>${EOM}`);
      return this.read();
    });
    this.tail = run.catch(() => undefined).finally(() => { this.idle = setTimeout(() => this.close(), this.idleMs); this.idle.unref?.(); });
    return run;
  }

  close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    try { this.stream?.end(); } catch { /* closing */ }
    this.ssh.close();
  }
}

export class NetconfTransport implements DeviceTransport {
  readonly kind = "netconf" as const;
  private sessions = new Map<string, NetconfSession>();
  private opening = new Map<string, Promise<NetconfSession>>();
  private o: { hostKeys: HostKeyStore; env?: Record<string, string | undefined>; connectTimeoutMs: number; commandTimeoutMs: number; idleMs: number };

  constructor(private targetFor: (d: DeviceRef) => SshTarget | null, opts: { hostKeys: HostKeyStore; env?: Record<string, string | undefined>; connectTimeoutMs?: number; commandTimeoutMs?: number; idleMs?: number }) {
    this.o = { connectTimeoutMs: 15_000, commandTimeoutMs: 60_000, idleMs: 60_000, ...opts };
  }

  private async session(d: DeviceRef): Promise<NetconfSession> {
    const t = this.targetFor(d);
    if (!t) throw new Error(`${d.label}: no NETCONF address or credential is known for this device.`);
    const hit = this.sessions.get(d.id);
    if (hit && !hit.closed) return hit;
    let p = this.opening.get(d.id);
    if (!p) {
      p = (async () => {
        const ssh = new Session(t, "junos", this.o);
        const s = new NetconfSession(ssh, t.label, this.o.commandTimeoutMs, this.o.idleMs);
        try { await s.open(); } catch (e) { s.close(); throw e; }
        this.sessions.set(d.id, s);
        return s;
      })().finally(() => this.opening.delete(d.id));
      this.opening.set(d.id, p);
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
      const reply = await (await this.session(device)).rpc(`<command format="text">${xmlEscape(command.trim())}</command>`);
      const err = rpcError(reply);
      if (err) return { ok: false, text: redactSecrets(err) };
      const out = reply.match(/<(?:output|configuration-output)[^>]*>([\s\S]*?)<\/(?:output|configuration-output)>/)?.[1] ?? "";
      return { ok: true, text: redactSecrets(xmlUnescape(out).replace(/^\n+|\s+$/g, "")) };
    } catch (e) {
      return this.fail(e);
    }
  }

  pushSupport(d: DeviceRef) {
    return d.platform === "junos" ? ({ ok: true } as const) : ({ ok: false, reason: `NETCONF changes are supported for Junos only, not ${d.platform}` } as const);
  }

  async push(device: DeviceRef, commands: string[], opts?: PushOptions): Promise<PushOutcome> {
    const bad = blockedLines(commands, "junos");
    if (bad.length) return { ok: false, text: `Refused before sending anything: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}.`, applied: [], failedAt: bad[0].line };
    const notJunosStyle = commands.find((c) => !/^(set|delete)\s+\S/.test(c.trim()));
    if (notJunosStyle) return { ok: false, text: `"${notJunosStyle.slice(0, 60)}" is not a Junos set or delete line.`, applied: [], failedAt: notJunosStyle };
    let s: NetconfSession;
    try { s = await this.session(device); } catch (e) { return { ok: false, text: this.fail(e).text, applied: [], failedAt: null }; }
    let locked = false;
    const giveUp = async (text: string, failedAt: string | null): Promise<PushOutcome> => {
      // Throw the candidate away and release the lock so nothing half-entered stays behind.
      await s.rpc("<discard-changes/>").catch(() => undefined);
      if (locked) await s.rpc("<unlock><target><candidate/></target></unlock>").catch(() => undefined);
      return { ok: false, text: redactSecrets(text), applied: [], failedAt };
    };
    try {
      const lock = rpcError(await s.rpc("<lock><target><candidate/></target></lock>"));
      if (lock) return { ok: false, text: redactSecrets(`Could not lock the candidate configuration: ${lock}`), applied: [], failedAt: null };
      locked = true;
      const load = rpcError(await s.rpc(`<load-configuration action="set" format="text"><configuration-set>${xmlEscape(commands.join("\n"))}</configuration-set></load-configuration>`));
      if (load) {
        const near = load.match(/near "([^"]+)"/)?.[1];
        return giveUp(`The device rejected the change: ${load}`, near ? commands.find((c) => c.includes(near)) ?? null : null);
      }
      const check = rpcError(await s.rpc("<commit-configuration><check/></commit-configuration>"));
      if (check) return giveUp(`The device's commit check failed, so nothing was applied: ${check}`, null);
      const commit = opts?.final ? "<commit-configuration/>" : `<commit-configuration><confirmed/><confirm-timeout>${CONFIRM_MINUTES}</confirm-timeout></commit-configuration>`;
      const done = rpcError(await s.rpc(commit));
      if (done) return giveUp(`The commit failed: ${done}`, null);
      await s.rpc("<unlock><target><candidate/></target></unlock>").catch(() => undefined);
      locked = false;
      return { ok: true, text: opts?.final ? "Committed." : `Committed provisionally; it reverts by itself in ${CONFIRM_MINUTES} minutes unless confirmed.`, applied: commands, failedAt: null };
    } catch (e) {
      return giveUp(this.fail(e).text, null);
    }
  }

  async confirm(device: DeviceRef): Promise<CommandOutcome> {
    try {
      const err = rpcError(await (await this.session(device)).rpc("<commit-configuration/>"));
      return err ? { ok: false, text: redactSecrets(err) } : { ok: true, text: "Confirmed." };
    } catch (e) {
      return this.fail(e);
    }
  }

  async save(): Promise<CommandOutcome> {
    return { ok: true, text: "Junos commits are already persistent; there is nothing separate to save." };
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
