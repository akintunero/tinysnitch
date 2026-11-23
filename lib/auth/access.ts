import { randomBytes } from "node:crypto";
import type { Db } from "../database/db";
import { type User, countUsers, sessionUser } from "./store";

export const COOKIE = "ts_session";

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i;

/** True when the app listens beyond this machine (a container, say). It then refuses to run without a login. */
export const isExposed = (env: Record<string, string | undefined> = process.env): boolean => !LOOPBACK.test((env.APP_HOST ?? "127.0.0.1").trim());

export type AuthState = { enabled: boolean; exposed: boolean; setupRequired: boolean };

/**
 * Login is on once the first user exists. Until then it is off on a loopback-only install (a single person on their own
 * machine, as before), and the whole API is closed on an exposed one until the first administrator has been created.
 */
export function authState(db: Db, env: Record<string, string | undefined> = process.env): AuthState {
  const enabled = countUsers(db) > 0;
  const exposed = isExposed(env);
  return { enabled, exposed, setupRequired: !enabled && exposed };
}

const g = globalThis as unknown as { __tsSetupToken?: string };

/** Proves that whoever is creating the first administrator on an exposed install can read the server's environment or log. */
export function setupToken(env: Record<string, string | undefined> = process.env): string {
  return env.TS_SETUP_TOKEN?.trim() || (g.__tsSetupToken ??= randomBytes(18).toString("base64url"));
}

export function cookieValue(header: string | null, name = COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export const tokenOf = (req: Request): string | null => cookieValue(req.headers.get("cookie"));

/** The signed-in user for a request, or null. */
export function userFor(req: Request, db: Db): User | null {
  const t = tokenOf(req);
  return t ? sessionUser(db, t) : null;
}

const secure = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/** HttpOnly so scripts cannot read it, SameSite=Strict so other sites cannot use it, Secure whenever the page is https. */
export function setCookie(req: Request, token: string, maxAgeSec: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure(req) ? "; Secure" : ""}`;
}
export const clearCookie = (req: Request): string => setCookie(req, "", 0);
