import { createHmac, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Db } from "../database/db";
import { redactDeep } from "../security/redact";

/**
 * Webhooks: Tiny Snitch tells another system when something happens, instead of that system having to ask.
 *
 * Every event is written to a queue first, one row per hook, and delivered from there: a receiver that is down gets the
 * event again later with a growing delay (1 min, 5 min, 30 min, 2 h, 6 h) and then it is marked failed. Each request is
 * signed so the receiver can prove it came from here. Addresses are checked when the connection is made, not only when
 * the hook is saved, so a name that is later pointed at the server's own interfaces or a cloud metadata address is refused.
 */

export const CHANGE_EVENTS = ["change.proposed", "change.approved", "change.rejected", "change.deploying", "change.paused", "change.verified", "change.failed", "change.rolling_back", "change.rolled_back", "change.rollback_failed"] as const;
export const SERVICE_EVENTS = ["service.created", "service.active", "service.failed", "service.inactive", "service.retired"] as const;
export const EVENTS = [...CHANGE_EVENTS, ...SERVICE_EVENTS, "diagnostics.completed", "finding.opened", "drift.detected", "webhook.test"] as const;
export type EventType = (typeof EVENTS)[number];

export type Webhook = { id: string; name: string; url: string; events: string[]; enabled: boolean; createdBy: string | null; createdAt: string };
export type Delivery = { id: string; webhookId: string; event: string; status: "pending" | "delivered" | "failed"; attempts: number; nextAttemptAt: string; lastStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null };

export class WebhookError extends Error {}

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

// ---- where a hook may point --------------------------------------------------------------------------------------------------------

const v4 = (ip: string) => ip.split(".").map(Number);

/**
 * Loopback, link-local (which includes the cloud metadata address), unspecified and multicast are always refused.
 * Private ranges are allowed, because receivers on the inside of a network are the normal case, unless
 * TS_WEBHOOK_BLOCK_PRIVATE=1. TS_WEBHOOK_ALLOW_LOOPBACK=1 lets a receiver on this same machine through (tests, development).
 */
export function addressProblem(ip: string, env: Record<string, string | undefined> = process.env): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return addressProblem(mapped[1], env);
  const loopbackOk = env.TS_WEBHOOK_ALLOW_LOOPBACK === "1";
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    if (a === 0) return "an unspecified address";
    if (a === 127) return loopbackOk ? null : "a loopback address";
    if (a === 169 && b === 254) return "a link-local address (this includes cloud metadata services)";
    if (a >= 224) return "a multicast or reserved address";
    if (env.TS_WEBHOOK_BLOCK_PRIVATE === "1" && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))) return "a private address";
    return null;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" ) return "an unspecified address";
    if (lower === "::1") return loopbackOk ? null : "a loopback address";
    if (/^fe[89ab]/.test(lower)) return "a link-local address";
    if (lower.startsWith("ff")) return "a multicast address";
    if (env.TS_WEBHOOK_BLOCK_PRIVATE === "1" && /^f[cd]/.test(lower)) return "a private address";
    return null;
  }
  return "not an IP address";
}

export function validateWebhookUrl(raw: string, env: Record<string, string | undefined> = process.env): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new WebhookError("That is not a valid URL."); }
  if (raw.length > 500) throw new WebhookError("The URL is too long (500 characters at most).");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new WebhookError("Use an http:// or https:// URL.");
  if (u.username || u.password) throw new WebhookError("Do not put a user name or password in the URL; the signature proves where a request came from.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const why = addressProblem(host, env);
    if (why) throw new WebhookError(`That address is ${why}.`);
  } else if (/^localhost$/i.test(host) && env.TS_WEBHOOK_ALLOW_LOOPBACK !== "1") {
    throw new WebhookError("That address is a loopback address.");
  }
  return u;
}

// ---- hooks -------------------------------------------------------------------------------------------------------------------------------

type HookRow = { id: string; name: string; url: string; events_json: string; enabled: number; created_by: string | null; created_at: string };
const hookOf = (r: HookRow): Webhook => ({ id: r.id, name: r.name, url: r.url, events: JSON.parse(r.events_json) as string[], enabled: r.enabled === 1, createdBy: r.created_by, createdAt: r.created_at });

export function createWebhook(db: Db, input: { name: string; url: string; events: string[]; createdBy?: string | null }, env = process.env): { webhook: Webhook; secret: string } {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new WebhookError("Give the webhook a name of up to 80 characters.");
  const url = validateWebhookUrl(input.url, env).toString();
  const events = [...new Set(input.events)];
  if (!events.length) throw new WebhookError("Choose at least one event.");
  for (const e of events) if (e !== "*" && !(EVENTS as readonly string[]).includes(e)) throw new WebhookError(`Unknown event "${e}".`);
  const id = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  db.prepare("INSERT INTO webhooks (id, name, url, secret, events_json, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
    .run(id, name, url, secret, JSON.stringify(events), input.createdBy ?? null, new Date().toISOString());
  return { webhook: hookOf(db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as HookRow), secret };
}

export const listWebhooks = (db: Db): Webhook[] => (db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as HookRow[]).map(hookOf);
export const getWebhook = (db: Db, id: string): Webhook | null => { const r = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as HookRow | undefined; return r ? hookOf(r) : null; };
export const setWebhookEnabled = (db: Db, id: string, enabled: boolean): boolean => Number(db.prepare("UPDATE webhooks SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes) > 0;
export const deleteWebhook = (db: Db, id: string): boolean => Number(db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes) > 0;

type DeliveryRow = { id: string; webhook_id: string; event: string; status: Delivery["status"]; attempts: number; next_attempt_at: string; last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null };
const deliveryOf = (r: DeliveryRow): Delivery => ({ id: r.id, webhookId: r.webhook_id, event: r.event, status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at, lastStatus: r.last_status, lastError: r.last_error, createdAt: r.created_at, deliveredAt: r.delivered_at });
export function listDeliveries(db: Db, webhookId: string | null, limit = 50): Delivery[] {
  const rows = webhookId
    ? db.prepare("SELECT id, webhook_id, event, status, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(webhookId, limit)
    : db.prepare("SELECT id, webhook_id, event, status, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at FROM webhook_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
  return (rows as DeliveryRow[]).map(deliveryOf);
}

// ---- events ------------------------------------------------------------------------------------------------------------------------------

let autoDeliver = true;
/** Tests turn this off so they decide when delivery happens. */
export const setAutoDeliver = (v: boolean): void => { autoDeliver = v; };

/**
 * Queues an event for every enabled hook that wants it. It never throws and never waits for a receiver: a problem with
 * webhooks must not break the change, diagnostic run or backup that raised the event.
 */
export function emitEvent(db: Db, type: EventType, data: Record<string, unknown>): void {
  try {
    const hooks = db.prepare("SELECT id, events_json FROM webhooks WHERE enabled = 1").all() as { id: string; events_json: string }[];
    const wanted = hooks.filter((h) => { const ev = JSON.parse(h.events_json) as string[]; return ev.includes("*") || ev.includes(type); });
    if (!wanted.length) return;
    const now = new Date().toISOString();
    const payload = JSON.stringify({ id: randomUUID(), type, createdAt: now, data: redactDeep(data) });
    const insert = db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)");
    for (const h of wanted) insert.run(randomUUID(), h.id, type, payload, now, now);
    if (autoDeliver) setImmediate(() => { void deliverDue(db).catch(() => undefined); });
  } catch {
    /* the queue is unavailable; the event is lost, the caller carries on */
  }
}

// ---- sending -----------------------------------------------------------------------------------------------------------------------------

export type SendResult = { ok: boolean; status?: number; error?: string };
export type Sender = (url: string, secret: string, deliveryId: string, event: string, body: string) => Promise<SendResult>;

export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export const sendWebhook: Sender = (rawUrl, secret, deliveryId, event, body) =>
  new Promise((resolve) => {
    let u: URL;
    try { u = validateWebhookUrl(rawUrl); } catch (e) { return resolve({ ok: false, error: (e as Error).message }); }
    const lib = u.protocol === "https:" ? https : http;
    const t = Math.floor(Date.now() / 1000);
    const req = lib.request(u, {
      method: "POST",
      timeout: 5000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "TinySnitch-Webhook/1",
        "X-TinySnitch-Event": event,
        "X-TinySnitch-Delivery": deliveryId,
        "X-TinySnitch-Signature": sign(secret, t, body),
      },
      // The address is judged when the connection is made, so a name that resolves somewhere forbidden is refused.
      lookup: (host, options, cb) => {
        dns.lookup(host, { ...options, all: true }, (err, addrs) => {
          if (err) return (cb as (e: Error | null, a?: unknown, f?: number) => void)(err);
          const list = addrs as dns.LookupAddress[];
          for (const a of list) {
            const why = addressProblem(a.address);
            if (why) return (cb as (e: Error | null) => void)(new Error(`${host} resolves to ${why}`));
          }
          if ((options as { all?: boolean }).all) return (cb as (e: null, a: dns.LookupAddress[]) => void)(null, list);
          return (cb as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
        });
      },
    }, (res) => {
      let seen = 0;
      res.on("data", (c: Buffer) => { seen += c.length; if (seen > 4096) res.destroy(); });
      res.on("end", () => resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? { ok: true, status: res.statusCode } : { ok: false, status: res.statusCode, error: `The receiver answered ${res.statusCode}.` }));
      res.on("error", () => resolve({ ok: false, status: res.statusCode, error: "The response was cut off." }));
    });
    req.on("timeout", () => { req.destroy(new Error("timed out after 5 seconds")); });
    req.on("error", (e) => resolve({ ok: false, error: e.message.slice(0, 200) }));
    req.end(body);
  });

const inFlight = new Set<string>();

/** Sends what is due. A failure schedules the next attempt; after the last one the delivery is marked failed. */
export async function deliverDue(db: Db, now = Date.now(), send: Sender = sendWebhook): Promise<{ delivered: number; failed: number; retried: number }> {
  const out = { delivered: 0, failed: 0, retried: 0 };
  const due = db.prepare("SELECT d.id, d.event, d.payload_json, d.attempts, h.url, h.secret, h.enabled FROM webhook_deliveries d JOIN webhooks h ON h.id = d.webhook_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.created_at LIMIT 25")
    .all(new Date(now).toISOString()) as { id: string; event: string; payload_json: string; attempts: number; url: string; secret: string; enabled: number }[];
  for (const d of due) {
    if (inFlight.has(d.id)) continue;
    inFlight.add(d.id);
    try {
      if (d.enabled !== 1) {
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', last_error = 'The webhook was disabled before this was delivered.' WHERE id = ?").run(d.id);
        out.failed += 1;
        continue;
      }
      const r = await send(d.url, d.secret, d.id, d.event, d.payload_json);
      const attempts = d.attempts + 1;
      if (r.ok) {
        db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?").run(attempts, r.status ?? null, new Date(now).toISOString(), d.id);
        out.delivered += 1;
      } else if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ? WHERE id = ?").run(attempts, r.status ?? null, r.error ?? "failed", d.id);
        out.failed += 1;
      } else {
        db.prepare("UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
          .run(attempts, r.status ?? null, r.error ?? "failed", new Date(now + BACKOFF_SECONDS[attempts - 1] * 1000).toISOString(), d.id);
        out.retried += 1;
      }
    } finally {
      inFlight.delete(d.id);
    }
  }
  // Delivered and failed rows are history, not a queue: keep a month.
  db.prepare("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < ?").run(new Date(now - 30 * 86_400_000).toISOString());
  return out;
}

/** Queues a test event for one hook and sends it now, so the person can see whether the receiver answers and accepts the signature. */
export async function sendTest(db: Db, webhookId: string, send: Sender = sendWebhook): Promise<Delivery | null> {
  if (!getWebhook(db, webhookId)) return null;
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at) VALUES (?, ?, 'webhook.test', ?, 'pending', 0, ?, ?)")
    .run(id, webhookId, JSON.stringify({ id: randomUUID(), type: "webhook.test", createdAt: now, data: { message: "This is a test event from Tiny Snitch." } }), now, now);
  await deliverDue(db, Date.now(), send);
  const row = db.prepare("SELECT id, webhook_id, event, status, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  return row ? deliveryOf(row) : null;
}
