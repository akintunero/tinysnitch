import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../database/db";
import { type Role, ROLES } from "../auth/roles";

/**
 * API tokens: a way in for other systems. A token carries a role and can expire or be revoked. Only its SHA-256 is
 * stored, so a copy of the database cannot be used to call the API; the token itself is shown once, when it is made.
 */
export type ApiToken = { id: string; name: string; prefix: string; role: Role; createdBy: string | null; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null };

const PREFIX = "tsk_";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

type Row = { id: string; name: string; prefix: string; role: Role; created_by: string | null; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null };
const fromRow = (r: Row): ApiToken => ({ id: r.id, name: r.name, prefix: r.prefix, role: r.role, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });

export class TokenError extends Error {}

export function createApiToken(db: Db, input: { name: string; role: Role; expiresInDays?: number | null; createdBy?: string | null }, now = Date.now()): { token: string; record: ApiToken } {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new TokenError("Give the token a name of up to 80 characters.");
  if (!ROLES.includes(input.role)) throw new TokenError("Unknown role.");
  if (input.expiresInDays != null && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 3650)) throw new TokenError("Expiry must be a whole number of days from 1 to 3650.");
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const expires = input.expiresInDays ? new Date(now + input.expiresInDays * 86_400_000).toISOString() : null;
  db.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, name, hash(token), token.slice(0, PREFIX.length + 6), input.role, input.createdBy ?? null, new Date(now).toISOString(), expires);
  return { token, record: fromRow(db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as Row) };
}

export function listApiTokens(db: Db): ApiToken[] {
  return (db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC").all() as Row[]).map(fromRow);
}

export function revokeApiToken(db: Db, id: string, now = Date.now()): boolean {
  return Number(db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date(now).toISOString(), id).changes) > 0;
}

/** The token's record when it is genuine, not expired and not revoked. Notes when it was last used, at most once a minute. */
export function verifyApiToken(db: Db, presented: string, now = Date.now()): ApiToken | null {
  if (!presented.startsWith(PREFIX) || presented.length > 200) return null;
  const r = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash(presented)) as Row | undefined;
  if (!r || r.revoked_at) return null;
  if (r.expires_at && Date.parse(r.expires_at) <= now) return null;
  if (!r.last_used_at || now - Date.parse(r.last_used_at) > 60_000) db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), r.id);
  return fromRow(r);
}

/** The token in an "Authorization: Bearer ..." header, or null. */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}

// ---- rate limit: a sliding window per token, in memory ------------------------------------------------------------------------

export const RATE_PER_MINUTE = 300;
const windows = new Map<string, number[]>();

/** True when the call is within the limit. Otherwise `retryAfter` is how many seconds until it would be. */
export function checkRate(tokenId: string, now = Date.now(), limit = RATE_PER_MINUTE): { ok: true } | { ok: false; retryAfter: number } {
  const recent = (windows.get(tokenId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) { windows.set(tokenId, recent); return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000)) }; }
  recent.push(now);
  windows.set(tokenId, recent);
  return { ok: true };
}
export const resetRateLimits = (): void => windows.clear();
