import { createHmac } from "node:crypto";
import dns from "node:dns";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as openapiGet } from "@/app/api/v1/openapi.json/route";
import { POST as tokensPost, GET as tokensGet } from "@/app/api/tokens/route";
import { DELETE as tokenDelete } from "@/app/api/tokens/[id]/route";
import { DELETE as hookDelete, PUT as hookPut } from "@/app/api/webhooks/[id]/route";
import { POST as hookTest } from "@/app/api/webhooks/[id]/test/route";
import { GET as hooksGet, POST as hooksPost } from "@/app/api/webhooks/route";
import { POST as v1Action } from "@/app/api/v1/changes/[id]/[action]/route";
import { GET as v1ChangesGet, POST as v1ChangesPost } from "@/app/api/v1/changes/route";
import { GET as v1Networks } from "@/app/api/v1/networks/route";
import { PUT as settingsPut } from "@/app/api/settings/route";
import { GET as usersGet } from "@/app/api/users/route";
import { RATE_PER_MINUTE, checkRate, createApiToken, listApiTokens, resetRateLimits, revokeApiToken, verifyApiToken } from "@/lib/api/tokens";
import { documentedPaths, openApiDocument } from "@/lib/api/openapi";
import { EVENTS, MAX_ATTEMPTS, addressProblem, createWebhook, deliverDue, emitEvent, listDeliveries, listWebhooks, setAutoDeliver, sign, validateWebhookUrl } from "@/lib/api/webhooks";
import { createSession, createUser } from "@/lib/auth/store";
import { recordBackup } from "@/lib/backup/store";
import { createChange, updateChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { listAudit } from "@/lib/database/repo";
import { saveRun } from "@/lib/diagnostics/store";
import type { Finding, RunSummary } from "@/lib/diagnostics/types";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { resetThrottle } from "@/lib/auth/throttle";

const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
const PW = "correct horse battery staple";
const REMOTE = "tinysnitch.corp.example:3000"; // not localhost: what another system would send

function boot(opts: { login?: boolean } = {}) {
  const db = openDatabase(":memory:");
  setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", lastConnectAttempt: 0, llm: null, claude });
  return db;
}
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const call = (handler: (r: Request, c?: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown; host?: string; token?: string; cookie?: string; headers?: Record<string, string> } = {}, params: Record<string, string> = {}) => {
  const headers: Record<string, string> = { host: init.host ?? "localhost:3000", ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = `ts_session=${init.cookie}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://${headers.host}${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  return (handler as unknown as (r: Request, c: unknown) => Promise<Response>)(req, ctx(params));
};
const j = async (r: Response) => (await r.json()) as Record<string, any>;

afterEach(() => { setContext(undefined); setProviders(null); resetRateLimits(); resetThrottle(); setAutoDeliver(true); delete process.env.TS_WEBHOOK_ALLOW_LOOPBACK; delete process.env.TS_WEBHOOK_BLOCK_PRIVATE; vi.restoreAllMocks(); });
beforeEach(() => setAutoDeliver(false));

describe("API tokens", () => {
  it("shows the token once and keeps only its hash", () => {
    const db = boot();
    const { token, record } = createApiToken(db, { name: "ci", role: "operator" });
    expect(token).toMatch(/^tsk_[A-Za-z0-9_-]{40,}$/);
    const raw = JSON.stringify(db.prepare("SELECT * FROM api_tokens").all());
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice(4));
    expect(listApiTokens(db)[0]).toMatchObject({ id: record.id, name: "ci", role: "operator", prefix: token.slice(0, 10) });
    expect(JSON.stringify(listApiTokens(db))).not.toContain(token);
  });

  it("accepts a genuine token and nothing else: wrong, cut short, wrong prefix, revoked, expired", () => {
    const db = boot();
    const { token, record } = createApiToken(db, { name: "ci", role: "viewer", expiresInDays: 1 }, Date.parse("2026-01-01T00:00:00Z"));
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(verifyApiToken(db, token, now)?.id).toBe(record.id);
    expect(verifyApiToken(db, token.slice(0, -1), now)).toBeNull();
    expect(verifyApiToken(db, `${token}x`, now)).toBeNull();
    expect(verifyApiToken(db, token.replace("tsk_", "abc_"), now)).toBeNull();
    expect(verifyApiToken(db, "", now)).toBeNull();
    expect(verifyApiToken(db, token, Date.parse("2026-01-02T00:00:01Z"))).toBeNull(); // past its expiry
    expect(revokeApiToken(db, record.id)).toBe(true);
    expect(verifyApiToken(db, token, now)).toBeNull();
    expect(revokeApiToken(db, record.id)).toBe(false);
  });

  it("refuses bad names, roles and expiry", () => {
    const db = boot();
    expect(() => createApiToken(db, { name: " ", role: "viewer" })).toThrow(/name/);
    expect(() => createApiToken(db, { name: "x", role: "root" as never })).toThrow(/role/);
    expect(() => createApiToken(db, { name: "x", role: "viewer", expiresInDays: 0 })).toThrow(/Expiry/);
  });

  it("notes when a token was last used", () => {
    const db = boot();
    const { token, record } = createApiToken(db, { name: "ci", role: "viewer" });
    expect(listApiTokens(db)[0].lastUsedAt).toBeNull();
    verifyApiToken(db, token);
    expect(listApiTokens(db).find((t) => t.id === record.id)?.lastUsedAt).not.toBeNull();
  });
});

describe("calling the API with a token", () => {
  async function setup() {
    const db = boot();
    await createUser(db, { username: "alice", password: PW, role: "admin" }); // login is on
    const admin = createSession(db, (db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string }).id).token;
    const mk = (role: "viewer" | "operator" | "approver" | "admin") => createApiToken(db, { name: `t-${role}`, role }).token;
    return { db, admin, viewer: mk("viewer"), operator: mk("operator"), approver: mk("approver"), adminToken: mk("admin") };
  }

  it("answers a caller on any host, where the same call without a token is refused", async () => {
    const { viewer } = await setup();
    expect((await call(v1ChangesGet, "/api/v1/changes?scope=x", { host: REMOTE, token: viewer })).status).not.toBe(403);
    const without = await call(v1ChangesGet, "/api/v1/changes?scope=x", { host: REMOTE });
    expect(without.status).toBe(403);
    expect((await j(without)).error).toMatch(/localhost/);
  });

  it("says 401 for a token that is wrong, revoked or expired, and never treats it as 'login is off'", async () => {
    const { db, viewer } = await setup();
    expect((await call(v1Networks, "/api/v1/networks", { token: "tsk_nope" })).status).toBe(401);
    expect((await call(v1Networks, "/api/v1/networks")).status).toBe(401); // no token, no cookie: sign in
    const id = listApiTokens(db).find((t) => t.name === "t-viewer")!.id;
    revokeApiToken(db, id);
    const r = await call(v1Networks, "/api/v1/networks", { token: viewer });
    expect(r.status).toBe(401);
    expect((await j(r)).code).toBe("invalid_token");
  });

  it("holds a token to its role", async () => {
    const { viewer, operator, approver } = await setup();
    const proposal = { title: "t", devices: [{ device: "R1", commands: ["interface Lo1"] }], scopeId: "static:none" };
    expect((await call(v1ChangesPost, "/api/v1/changes", { token: viewer, body: proposal })).status).toBe(403);
    expect((await call(v1ChangesPost, "/api/v1/changes", { token: operator, body: proposal })).status).not.toBe(403);
    expect((await call(v1Action, "/api/v1/changes/x/approve", { token: operator, method: "POST", body: {} }, { id: "x", action: "approve" })).status).toBe(403);
    expect((await call(v1Action, "/api/v1/changes/x/approve", { token: approver, method: "POST", body: {} }, { id: "x", action: "approve" })).status).toBe(404);
  });

  it("keeps users, tokens, webhooks and settings for a signed-in person, whatever the token's role", async () => {
    const { adminToken, admin } = await setup();
    for (const [handler, path, init] of [
      [tokensGet, "/api/tokens", {}], [tokensPost, "/api/tokens", { body: { name: "x", role: "viewer" } }], [hooksGet, "/api/webhooks", {}],
      [hooksPost, "/api/webhooks", { body: { name: "x", url: "https://example.com", events: ["*"] } }], [usersGet, "/api/users", {}], [settingsPut, "/api/settings", { method: "PUT", body: { complianceChecks: "all" } }],
    ] as const) {
      const r = await call(handler as never, path, { ...init, token: adminToken, host: REMOTE });
      expect(r.status, path).toBe(403);
      expect((await j(r)).code, path).toBe("session_required");
    }
    expect((await call(tokensGet as never, "/api/tokens", { cookie: admin })).status).toBe(200); // the same call by a person is fine
  });

  it("wants JSON for a write, and limits each token to a number of calls a minute", async () => {
    const { operator, viewer } = await setup();
    const r = await call(v1ChangesPost, "/api/v1/changes", { token: operator, host: REMOTE, method: "POST", headers: { "content-type": "text/plain" } });
    expect(r.status).toBe(415);
    let last: Response | null = null;
    let ok = 0;
    for (let i = 0; i < RATE_PER_MINUTE + 5; i++) { last = await call(v1Networks, "/api/v1/networks", { token: viewer }); if (last.status !== 429) ok += 1; }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(ok).toBeLessThanOrEqual(RATE_PER_MINUTE);
    expect(checkRate("someone", 0, 2).ok && checkRate("someone", 1, 2).ok).toBe(true);
    expect(checkRate("someone", 2, 2)).toEqual({ ok: false, retryAfter: 60 });
    expect(checkRate("someone", 61_001, 2).ok).toBe(true); // the window slides
  });

  it("lets a person make, list and revoke tokens, and a revoked one stops working at once", async () => {
    const { db, admin, viewer } = await setup();
    const made = await call(tokensPost, "/api/tokens", { cookie: admin, body: { name: "partner", role: "viewer", expiresInDays: 30 } });
    expect(made.status).toBe(201);
    const { token, record } = await j(made);
    expect(token).toMatch(/^tsk_/);
    const list = await j(await call(tokensGet as never, "/api/tokens", { cookie: admin }));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.tokens.find((t: { id: string }) => t.id === record.id)).toMatchObject({ name: "partner", role: "viewer" });
    expect((await call(v1Networks, "/api/v1/networks", { token })).status).not.toBe(401);
    expect((await call(tokenDelete as never, `/api/tokens/${record.id}`, { cookie: admin, method: "DELETE", body: {} }, { id: record.id })).status).toBe(200);
    expect((await call(v1Networks, "/api/v1/networks", { token })).status).toBe(401);
    expect(listAudit(db).some((e) => /Revoked API token "partner"/.test(e.summary))).toBe(true);
    expect(JSON.stringify(listAudit(db))).not.toContain(token);
    expect(viewer).toBeTruthy();
  });

  it("names the token in the audit log for what it does", async () => {
    const { db, operator } = await setup();
    const r = await call(v1Action, "/api/v1/changes/x/reject", { token: operator, method: "POST", body: {} }, { id: "x", action: "reject" });
    expect(r.status).toBe(403); // an operator cannot reject, so nothing is recorded under its name
    expect(listAudit(db).some((e) => e.actor.includes("t-operator"))).toBe(false);
  });
});

describe("idempotent proposals", () => {
  function inventory() {
    process.env.TS_API_PW = "x";
    const file = join(mkdtempSync(join(tmpdir(), "ts-api-")), "inv.yaml");
    writeFileSync(file, "credentials:\n  c: { username: admin, password: env:TS_API_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: 1, platform: ios }\n");
    setProviders([new StaticProvider(file)]);
  }

  it("returns the first answer for a retry and refuses the same key with a different body", async () => {
    const db = boot();
    inventory();
    const { token } = createApiToken(db, { name: "ci", role: "operator" });
    const body = { scopeId: "static:s", title: "Loopback", devices: [{ device: "R1", commands: ["interface Loopback9", " ip address 10.9.9.9 255.255.255.255"] }] };
    const first = await call(v1ChangesPost, "/api/v1/changes", { token, body, headers: { "idempotency-key": "order-1" } });
    expect(first.status).toBe(201);
    const made = await j(first);
    const again = await call(v1ChangesPost, "/api/v1/changes", { token, body, headers: { "idempotency-key": "order-1" } });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect((await j(again)).id).toBe(made.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(1);
    const clash = await call(v1ChangesPost, "/api/v1/changes", { token, body: { ...body, title: "Something else" }, headers: { "idempotency-key": "order-1" } });
    expect(clash.status).toBe(422);
    expect((await j(clash)).code).toBe("idempotency_conflict");
    // another caller's key is a different key
    const other = createApiToken(db, { name: "other", role: "operator" }).token;
    expect((await call(v1ChangesPost, "/api/v1/changes", { token: other, body, headers: { "idempotency-key": "order-1" } })).headers.get("idempotent-replay")).toBeNull();
    expect((await call(v1ChangesPost, "/api/v1/changes", { token, body, headers: { "idempotency-key": "bad key\u0001" } })).status).toBe(400);
  });
});

describe("where a webhook may point", () => {
  it.each([
    ["127.0.0.1", "a loopback address"], ["127.5.5.5", "a loopback address"], ["::1", "a loopback address"], ["169.254.169.254", "a link-local address"], ["fe80::1", "a link-local address"],
    ["0.0.0.0", "an unspecified address"], ["224.0.0.5", "a multicast"], ["::ffff:127.0.0.1", "a loopback address"], ["::ffff:169.254.169.254", "a link-local address"],
  ])("refuses %s", (ip, why) => { expect(addressProblem(ip, {})).toContain(why); });

  it("allows public and private receivers, and can be told to refuse private ones", () => {
    for (const ip of ["8.8.8.8", "10.1.2.3", "172.16.0.9", "192.168.1.5", "2606:4700::1111"]) expect(addressProblem(ip, {}), ip).toBeNull();
    for (const ip of ["10.1.2.3", "172.16.0.9", "192.168.1.5", "fd00::1"]) expect(addressProblem(ip, { TS_WEBHOOK_BLOCK_PRIVATE: "1" }), ip).toContain("private");
    expect(addressProblem("127.0.0.1", { TS_WEBHOOK_ALLOW_LOOPBACK: "1" })).toBeNull();
  });

  it("checks the URL when the hook is made", () => {
    const db = boot();
    const make = (url: string, events: string[] = ["*"]) => () => createWebhook(db, { name: "h", url, events }, {} as never);
    expect(make("not a url")).toThrow(/valid URL/);
    expect(make("ftp://example.com/x")).toThrow(/http/);
    expect(make("https://user:pw@example.com/x")).toThrow(/user name or password/);
    expect(make("http://localhost:9/x")).toThrow(/loopback/);
    expect(make("http://169.254.169.254/latest/meta-data")).toThrow(/link-local/);
    expect(make("https://example.com/x", [])).toThrow(/at least one event/);
    expect(make("https://example.com/x", ["change.exploded"])).toThrow(/Unknown event/);
    expect(make(`https://example.com/${"a".repeat(600)}`)).toThrow(/too long/);
    expect(make("https://hooks.example.com/x")().webhook.url).toBe("https://hooks.example.com/x");
    expect(validateWebhookUrl("http://10.0.0.5:8080/in", {}).hostname).toBe("10.0.0.5");
  });
});

/** A real HTTP receiver on this machine. */
function receiver(script: ((n: number) => { status: number; location?: string })[] = []) {
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      const r = (script[got.length - 1] ?? script.at(-1) ?? (() => ({ status: 200 })))(got.length);
      res.writeHead(r.status, r.location ? { Location: r.location } : {});
      res.end("ok");
    });
  });
  return new Promise<{ url: string; got: typeof got; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, got, close: () => server.close() })));
}

describe("webhooks", () => {
  let rx: Awaited<ReturnType<typeof receiver>> | null = null;
  afterEach(() => { rx?.close(); rx = null; });
  const allow = () => { process.env.TS_WEBHOOK_ALLOW_LOOPBACK = "1"; };

  it("queues an event for the hooks that want it, and only those", () => {
    const db = boot();
    allow();
    const a = createWebhook(db, { name: "a", url: "http://127.0.0.1:9/a", events: ["change.verified"] }).webhook;
    const b = createWebhook(db, { name: "b", url: "http://127.0.0.1:9/b", events: ["*"] }).webhook;
    const c = createWebhook(db, { name: "c", url: "http://127.0.0.1:9/c", events: ["drift.detected"] }).webhook;
    const d = createWebhook(db, { name: "d", url: "http://127.0.0.1:9/d", events: ["*"] }).webhook;
    db.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(d.id);
    emitEvent(db, "change.verified", { changeId: "1" });
    const who = (id: string) => listDeliveries(db, id).length;
    expect([who(a.id), who(b.id), who(c.id), who(d.id)]).toEqual([1, 1, 0, 0]);
  });

  it("does nothing, and costs nothing, when there are no hooks", () => {
    const db = boot();
    emitEvent(db, "change.verified", {});
    expect((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number }).n).toBe(0);
  });

  it("delivers a signed POST that a receiver can verify, with the headers it needs", async () => {
    const db = boot();
    allow();
    rx = await receiver();
    const { webhook, secret } = createWebhook(db, { name: "ci", url: rx.url, events: ["*"] });
    emitEvent(db, "drift.detected", { scopeId: "s", device: "R1", linesAdded: 2, linesRemoved: 0, password: "hunter2" });
    expect(await deliverDue(db)).toEqual({ delivered: 1, failed: 0, retried: 0 });
    const hit = rx.got[0];
    expect(hit.headers["x-tinysnitch-event"]).toBe("drift.detected");
    expect(hit.headers["x-tinysnitch-delivery"]).toBe(listDeliveries(db, webhook.id)[0].id);
    expect(hit.headers["content-type"]).toBe("application/json");
    const sig = String(hit.headers["x-tinysnitch-signature"]);
    const [t, v1] = sig.split(",").map((p) => p.split("=")[1]);
    expect(v1).toBe(createHmac("sha256", secret).update(`${t}.${hit.body}`).digest("hex"));
    expect(sig).toBe(sign(secret, Number(t), hit.body));
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(30);
    const payload = JSON.parse(hit.body);
    expect(payload).toMatchObject({ type: "drift.detected", data: { scopeId: "s", device: "R1", linesAdded: 2 } });
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(payload)).not.toContain("hunter2"); // secrets are masked before they leave
    expect(listDeliveries(db, webhook.id)[0]).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200 });
  });

  it("retries a receiver that is failing with a growing delay, then gives up", async () => {
    const db = boot();
    allow();
    rx = await receiver([() => ({ status: 500 })]);
    const { webhook } = createWebhook(db, { name: "ci", url: rx.url, events: ["*"] });
    emitEvent(db, "change.failed", { changeId: "1" });
    const t0 = Date.now();
    const delays = [60, 300, 1800, 7200, 21600];
    let now = t0;
    for (let i = 0; i < delays.length; i++) {
      expect(await deliverDue(db, now)).toMatchObject({ retried: 1 });
      const d = listDeliveries(db, webhook.id)[0];
      expect(d).toMatchObject({ status: "pending", attempts: i + 1, lastStatus: 500 });
      expect(Date.parse(d.nextAttemptAt) - now).toBe(delays[i] * 1000);
      expect(await deliverDue(db, now + delays[i] * 1000 - 1)).toEqual({ delivered: 0, failed: 0, retried: 0 }); // not due yet
      now += delays[i] * 1000;
    }
    expect(await deliverDue(db, now)).toMatchObject({ failed: 1 });
    expect(listDeliveries(db, webhook.id)[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(rx.got).toHaveLength(MAX_ATTEMPTS);
  });

  it("succeeds on a retry once the receiver recovers", async () => {
    const db = boot();
    allow();
    rx = await receiver([() => ({ status: 503 }), () => ({ status: 204 })]);
    const { webhook } = createWebhook(db, { name: "ci", url: rx.url, events: ["*"] });
    emitEvent(db, "change.verified", {});
    await deliverDue(db);
    await deliverDue(db, Date.now() + 61_000);
    expect(listDeliveries(db, webhook.id)[0]).toMatchObject({ status: "delivered", attempts: 2, lastStatus: 204 });
  });

  it("does not follow a redirect, which could lead somewhere the address rules forbid", async () => {
    const db = boot();
    allow();
    rx = await receiver([() => ({ status: 302, location: "http://169.254.169.254/latest/meta-data" })]);
    const { webhook } = createWebhook(db, { name: "ci", url: rx.url, events: ["*"] });
    emitEvent(db, "change.verified", {});
    await deliverDue(db);
    expect(listDeliveries(db, webhook.id)[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: 302 });
    expect(rx.got).toHaveLength(1);
  });

  it("refuses a name that resolves to a forbidden address when the connection is made", async () => {
    const db = boot();
    allow();
    const { webhook } = createWebhook(db, { name: "sneaky", url: "http://hooks.example.test:9/in", events: ["*"] });
    delete process.env.TS_WEBHOOK_ALLOW_LOOPBACK; // the receiver was fine when it was saved; now the name points at this machine
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
    emitEvent(db, "change.verified", {});
    await deliverDue(db);
    expect(listDeliveries(db, webhook.id)[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(listDeliveries(db, webhook.id)[0].lastError).toMatch(/resolves to a loopback/);
  });

  it("marks a delivery failed when its hook was disabled in the meantime", async () => {
    const db = boot();
    allow();
    const { webhook } = createWebhook(db, { name: "ci", url: "http://127.0.0.1:9/x", events: ["*"] });
    emitEvent(db, "change.verified", {});
    db.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(webhook.id);
    expect(await deliverDue(db)).toMatchObject({ failed: 1 });
  });
});

describe("events raised by the app itself", () => {
  it("tells a receiver about each step of a change, without the configuration lines", () => {
    const db = boot();
    process.env.TS_WEBHOOK_ALLOW_LOOPBACK = "1";
    const { webhook } = createWebhook(db, { name: "ci", url: "http://127.0.0.1:9/x", events: ["change.*".replace(".*", ".proposed"), "change.approved", "change.verified", "change.rolled_back"] });
    const c = createChange(db, { scopeId: "s", environment: "lab", title: "Add Loopback9", intent: "", source: "user", plan: { devices: [{ deviceId: "d", label: "R1", platform: "ios", commands: ["interface Loopback9", " ip address 10.9.9.9 255.255.255.255"], risks: [] }], warnings: [] }, createdBy: "ci" });
    updateChange(db, c.id, { status: "approved" });
    updateChange(db, c.id, { status: "approved" }); // no change of status, no new event
    updateChange(db, c.id, { status: "deploying" }); // a status nobody subscribed to
    updateChange(db, c.id, { status: "verified" });
    const events = listDeliveries(db, webhook.id).map((d) => d.event).reverse();
    expect(events).toEqual(["change.proposed", "change.approved", "change.verified"]);
    const payloads = (db.prepare("SELECT payload_json FROM webhook_deliveries").all() as { payload_json: string }[]).map((r) => r.payload_json).join("\n");
    expect(payloads).toContain("Add Loopback9");
    expect(payloads).not.toContain("10.9.9.9");
    expect(payloads).not.toContain("interface Loopback9");
  });

  it("reports a diagnostics run, each new finding, and drift", () => {
    const db = boot();
    process.env.TS_WEBHOOK_ALLOW_LOOPBACK = "1";
    createWebhook(db, { name: "all", url: "http://127.0.0.1:9/x", events: ["*"] });
    const finding = (id: string): Finding => ({ id, kind: "bgp-peer-down", severity: "critical", status: "confirmed", device: "R1", deviceId: "r1", interface: null, peer: null, linkId: null, title: "BGP peer down", description: "d", evidence: [], probableCause: "", recommendedAction: "", verification: "" });
    const run = (id: string): RunSummary => ({ id, labId: "s", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", devices: [{ nodeId: "r1", label: "R1", kind: "router", inspected: true, reason: null, commandsRun: 4, commandsFailed: 0 }], interfaces: {}, pings: [], notRun: [] });
    saveRun(db, run("r1"), [finding("f1")]);
    saveRun(db, run("r2"), [finding("f1")]); // the same finding again is not new
    const kinds = (db.prepare("SELECT event FROM webhook_deliveries ORDER BY rowid").all() as { event: string }[]).map((r) => r.event);
    expect(kinds).toEqual(["diagnostics.completed", "finding.opened", "diagnostics.completed"]);
    recordBackup(db, { scopeId: "s", device: "R1", config: "hostname R1\ninterface Gi0/0\n ip address 10.0.0.1 255.255.255.0\n", source: "manual" });
    recordBackup(db, { scopeId: "s", device: "R1", config: "hostname R1\ninterface Gi0/0\n ip address 10.0.0.2 255.255.255.0\n", source: "manual" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'drift.detected'").get() as { n: number }).n).toBe(1);
  });

  it("never lets a broken webhook table break the change that raised the event", () => {
    const db = boot();
    createWebhook(db, { name: "ci", url: "https://hooks.example.com/x", events: ["*"] });
    db.exec("DROP TABLE webhook_deliveries");
    expect(() => createChange(db, { scopeId: "s", environment: "lab", title: "t", intent: "", source: "user", plan: { devices: [], warnings: [] } })).not.toThrow();
  });
});

describe("managing webhooks from the page", () => {
  async function admin() {
    const db = boot();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    await createUser(db, { username: "dan", password: PW, role: "approver" });
    const sid = (n: string) => createSession(db, (db.prepare("SELECT id FROM users WHERE username = ?").get(n) as { id: string }).id).token;
    return { db, alice: sid("alice"), dan: sid("dan") };
  }

  it("makes a hook, shows its secret once, lists it without the secret, tests it, disables and deletes it", async () => {
    const { db, alice } = await admin();
    process.env.TS_WEBHOOK_ALLOW_LOOPBACK = "1";
    const rx = await receiver();
    try {
      const made = await call(hooksPost, "/api/webhooks", { cookie: alice, body: { name: "ci", url: rx.url, events: ["change.verified", "drift.detected"] } });
      expect(made.status).toBe(201);
      const { webhook, secret } = await j(made);
      expect(secret).toMatch(/^whsec_/);
      const listed = JSON.stringify(await j(await call(hooksGet as never, "/api/webhooks", { cookie: alice })));
      expect(listed).not.toContain(secret);
      expect(listed).toContain("ci");
      expect(JSON.stringify(listAudit(db))).not.toContain(secret);

      const test = await call(hookTest as never, `/api/webhooks/${webhook.id}/test`, { cookie: alice, method: "POST", body: {} }, { id: webhook.id });
      expect(await j(test)).toMatchObject({ event: "webhook.test", status: "delivered" });
      expect(rx.got[0].headers["x-tinysnitch-event"]).toBe("webhook.test");

      expect((await call(hookPut as never, `/api/webhooks/${webhook.id}`, { cookie: alice, method: "PUT", body: { enabled: false } }, { id: webhook.id })).status).toBe(200);
      expect(listWebhooks(db)[0].enabled).toBe(false);
      expect((await call(hookDelete as never, `/api/webhooks/${webhook.id}`, { cookie: alice, method: "DELETE", body: {} }, { id: webhook.id })).status).toBe(200);
      expect(listWebhooks(db)).toHaveLength(0);
      expect((await call(hookTest as never, "/api/webhooks/gone/test", { cookie: alice, method: "POST", body: {} }, { id: "gone" })).status).toBe(404);
    } finally { rx.close(); }
  });

  it("refuses a bad address with a clear message, and keeps all of this to administrators", async () => {
    const { alice, dan } = await admin();
    const bad = await call(hooksPost, "/api/webhooks", { cookie: alice, body: { name: "x", url: "http://169.254.169.254/", events: ["*"] } });
    expect(bad.status).toBe(400);
    expect((await j(bad)).error).toMatch(/link-local/);
    expect((await call(hooksPost, "/api/webhooks", { cookie: dan, body: { name: "x", url: "https://example.com/", events: ["*"] } })).status).toBe(403);
    expect((await call(tokensPost, "/api/tokens", { cookie: dan, body: { name: "x", role: "viewer" } })).status).toBe(403);
  });
});

describe("the published description of the API", () => {
  const v1 = join(__dirname, "..", "app", "api", "v1");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : f === "route.ts" ? [p] : []; });
  const pathOf = (file: string) => `/api/v1/${relative(v1, file).replace(/\\/g, "/").replace(/\/?route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}")}`.replace(/\/$/, "");

  it("documents every path, and every documented path exists as a route", () => {
    const routes = files(v1).map(pathOf).filter((p) => p !== "/api/v1/openapi.json").sort();
    expect(documentedPaths().sort()).toEqual(routes);
    for (const p of documentedPaths()) expect(existsSync(join(v1, ...p.replace("/api/v1/", "").split("/").map((s) => s.replace(/\{(\w+)\}/, "[$1]")), "route.ts")), p).toBe(true);
  });

  it("is valid-looking OpenAPI that names the role each call needs and every event", async () => {
    const db = boot();
    const { token } = createApiToken(db, { name: "docs", role: "viewer" });
    const r = await call(openapiGet, "/api/v1/openapi.json", { token, host: REMOTE });
    expect(r.status).toBe(200);
    const doc = await j(r);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe(`http://${REMOTE}`);
    expect(doc.paths["/api/v1/changes"].post["x-required-role"]).toBe("operator");
    expect(doc.paths["/api/v1/changes/{id}/{action}"].post["x-required-role"]).toBe("approver");
    expect(doc.paths["/api/v1/changes"].post.parameters.map((p: { name: string }) => p.name)).toContain("Idempotency-Key");
    for (const e of EVENTS) expect(doc.info.description).toContain(e);
    expect(JSON.stringify(openApiDocument())).not.toContain("undefined");
  });
});
