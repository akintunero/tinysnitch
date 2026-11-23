import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../database/db";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "./password";
import { type Role, atLeast, isRole } from "./roles";

export type User = { id: string; username: string; role: Role; disabled: boolean; createdAt: string; lastLoginAt: string | null };

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AuthError";
  }
}

export const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;
export const SESSION_IDLE_MS = 8 * 3_600_000;
export const SESSION_MAX_MS = 7 * 86_400_000;

type Row = { id: string; username: string; role: string; disabled: number; created_at: string; last_login_at: string | null; password_hash?: string };
const userOf = (r: Row): User => ({ id: r.id, username: r.username, role: (isRole(r.role) ? r.role : "viewer"), disabled: r.disabled === 1, createdAt: r.created_at, lastLoginAt: r.last_login_at });
const COLS = "id, username, role, disabled, created_at, last_login_at";

export const countUsers = (db: Db): number => Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
export const listUsers = (db: Db): User[] => (db.prepare(`SELECT ${COLS} FROM users ORDER BY username COLLATE NOCASE`).all() as Row[]).map(userOf);
export const getUser = (db: Db, id: string): User | null => { const r = db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as Row | undefined; return r ? userOf(r) : null; };
export const getUserByName = (db: Db, name: string): User | null => { const r = db.prepare(`SELECT ${COLS} FROM users WHERE username = ?`).get(name) as Row | undefined; return r ? userOf(r) : null; };

/** People who can approve changes and are able to sign in, other than `exceptName`. Four-eyes approval needs at least one. */
export function otherApprovers(db: Db, exceptName: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND role IN ('approver', 'admin') AND username <> ? COLLATE NOCASE").get(exceptName) as { n: number }).n);
}

const enabledAdmins = (db: Db): number => Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND role = 'admin'").get() as { n: number }).n);

export async function createUser(db: Db, input: { username: string; password: string; role: Role }): Promise<User> {
  if (!USERNAME.test(input.username)) throw new AuthError("A username is 3 to 40 letters, digits, dots, dashes or underscores.");
  if (!isRole(input.role)) throw new AuthError("Unknown role.");
  const problem = passwordProblem(input.password, input.username);
  if (problem) throw new AuthError(problem);
  if (getUserByName(db, input.username)) throw new AuthError("That username is taken.", 409);
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(id, input.username, await hashPassword(input.password), input.role, new Date().toISOString());
  return getUser(db, id)!;
}

/** Signs a person in if the password is right. A wrong user, a wrong password and a disabled account all look the same. */
export async function checkLogin(db: Db, username: string, password: string): Promise<User | null> {
  const r = db.prepare(`SELECT ${COLS}, password_hash FROM users WHERE username = ?`).get(username) as Row | undefined;
  const ok = await verifyPassword(password, r?.password_hash ?? (await dummyHash()));
  if (!r || !ok || r.disabled === 1) return null;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
  return userOf(r);
}

export async function setPassword(db: Db, userId: string, password: string, keepSession?: string): Promise<void> {
  const u = getUser(db, userId);
  if (!u) throw new AuthError("No such user.", 404);
  const problem = passwordProblem(password, u.username);
  if (problem) throw new AuthError(problem);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), userId);
  endSessions(db, userId, keepSession); // everyone else signed in as this person is signed out
}

export function updateUser(db: Db, id: string, patch: { role?: Role; disabled?: boolean }): User {
  const u = getUser(db, id);
  if (!u) throw new AuthError("No such user.", 404);
  if (patch.role !== undefined && !isRole(patch.role)) throw new AuthError("Unknown role.");
  const wasAdmin = u.role === "admin" && !u.disabled;
  const willBeAdmin = (patch.role ?? u.role) === "admin" && !(patch.disabled ?? u.disabled);
  if (wasAdmin && !willBeAdmin && enabledAdmins(db) <= 1) throw new AuthError("There must always be at least one administrator who can sign in.", 409);
  if (patch.role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
  if (patch.disabled !== undefined) db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(patch.disabled ? 1 : 0, id);
  if (patch.disabled || (patch.role !== undefined && patch.role !== u.role)) endSessions(db, id); // a changed role takes effect at the next sign-in
  return getUser(db, id)!;
}

export function deleteUser(db: Db, id: string): void {
  const u = getUser(db, id);
  if (!u) throw new AuthError("No such user.", 404);
  if (u.role === "admin" && !u.disabled && enabledAdmins(db) <= 1) throw new AuthError("There must always be at least one administrator who can sign in.", 409);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

// ---- sessions -----------------------------------------------------------------------------------------------------
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A random token goes to the browser; only its hash is stored, so a copy of the database cannot be used to sign in. */
export function createSession(db: Db, userId: string, now = Date.now()): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + SESSION_MAX_MS).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)").run(hashToken(token), userId, new Date(now).toISOString(), new Date(now).toISOString(), expiresAt);
  return { token, expiresAt };
}

/** The signed-in user for a session token, or null if it is unknown, idle too long, past its limit, or the user is disabled. */
export function sessionUser(db: Db, token: string, now = Date.now()): User | null {
  const h = hashToken(token);
  const r = db.prepare("SELECT user_id, last_seen, expires_at FROM sessions WHERE token_hash = ?").get(h) as { user_id: string; last_seen: string; expires_at: string } | undefined;
  if (!r) return null;
  if (now >= Date.parse(r.expires_at) || now - Date.parse(r.last_seen) >= SESSION_IDLE_MS) { db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(h); return null; }
  const u = getUser(db, r.user_id);
  if (!u || u.disabled) return null;
  if (now - Date.parse(r.last_seen) > 60_000) db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(new Date(now).toISOString(), h);
  return u;
}

export function endSession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function endSessions(db: Db, userId: string, exceptToken?: string): void {
  if (exceptToken) db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, hashToken(exceptToken));
  else db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export const purgeExpiredSessions = (db: Db, now = Date.now()): void => { db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date(now).toISOString()); };

export { atLeast };
