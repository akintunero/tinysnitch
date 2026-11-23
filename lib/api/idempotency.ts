import { createHash } from "node:crypto";
import { getContext } from "../server/context";
import { bearerOf } from "./tokens";

type Handler = (req: Request, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const KEEP_MS = 24 * 3_600_000;

/**
 * Makes a POST safe to retry. A client that sends the same Idempotency-Key again (a timeout, a retry after a network
 * error) gets the first answer back instead of creating a second change. The key is scoped to the caller's token, and
 * reusing a key with a different body is refused rather than guessed at. Answers are kept for 24 hours.
 * Two requests with the same new key arriving at the same instant can both run; retries after an answer cannot.
 */
export function withIdempotency(handler: Handler): Handler {
  return async (req, ctx) => {
    const key = req.headers.get("idempotency-key");
    if (!key) return handler(req, ctx);
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) return Response.json({ error: "Idempotency-Key must be 1 to 128 printable characters." }, { status: 400 });
    const { db } = getContext();
    const scope = sha(bearerOf(req) ?? req.headers.get("cookie") ?? "anonymous");
    const reqHash = sha(await req.clone().text());
    const prior = db.prepare("SELECT status, body FROM idempotency_keys WHERE scope = ? AND key = ?").get(scope, key) as { status: number; body: string } | undefined;
    if (prior) {
      const saved = JSON.parse(prior.body) as { h: string; b: string };
      if (saved.h !== reqHash) return Response.json({ error: "That Idempotency-Key was already used with a different request.", code: "idempotency_conflict" }, { status: 422 });
      return new Response(saved.b, { status: prior.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Idempotent-Replay": "true" } });
    }
    const res = await handler(req, ctx);
    if (res.status >= 200 && res.status < 300) {
      const text = await res.clone().text();
      db.prepare("INSERT OR IGNORE INTO idempotency_keys (scope, key, status, body, created_at) VALUES (?, ?, ?, ?, ?)").run(scope, key, res.status, JSON.stringify({ h: reqHash, b: text }), new Date().toISOString());
      db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
    }
    return res;
  };
}
