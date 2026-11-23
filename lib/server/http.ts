import { ZodError, type ZodType } from "zod";
import { bearerOf, checkRate, verifyApiToken } from "../api/tokens";
import { authState, userFor } from "../auth/access";
import { type Role, atLeast } from "../auth/roles";
import { addAudit } from "../database/repo";
import { type Actor, currentActor, runAs } from "../security/actor";
import { redactSecrets } from "../security/redact";
import { getContext } from "./context";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly headers?: Record<string, string>) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Rebinding and cross-site defences for a local app. The Host must be a loopback name; a browser-sent
 * write must come from this same origin and carry JSON.
 */
export function guard(req: Request, write: boolean): void {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_HOST.test(host)) throw new HttpError(403, "Tiny Snitch only answers on localhost.");
  if (!write) return;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== host) throw new HttpError(403, "Cross-origin requests are not allowed.");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site requests are not allowed.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send JSON (Content-Type: application/json).");
  }
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new HttpError(400, `Invalid request: ${r.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`);
  }
  return r.data;
}

export type RouteParams = Record<string, string>;

/** `params` is the dynamic-segment values (Next passes them as a promise); empty for static routes. */
export type RouteOptions = {
  /** A browser-sent write: it must be same-origin JSON. Needs `operator` unless `role` says otherwise. */
  write?: boolean;
  /** The lowest role that may call it. Default: viewer for reads, operator for writes. */
  role?: Role;
  /** Open to anyone: the sign-in and setup endpoints. */
  public?: boolean;
  /** A signed-in person only, never an API token: managing users, tokens, webhooks and settings. */
  sessionOnly?: boolean;
};

/** Throws 403 unless the signed-in user has at least `min`. When login is off nobody is signed in and everything is allowed. */
export function requireRole(min: Role): void {
  const a = currentActor();
  if (a && !atLeast(a.role, min)) throw new HttpError(403, `Your role (${a.role}) cannot do this; it needs ${min}.`, "forbidden");
}

/**
 * A call that carries an API token is not a browser, so the rules that protect a browser's cookies (loopback Host, same
 * origin) do not apply to it; a write must still send JSON. Whether the token is genuine is decided in authenticate().
 */
function guardToken(req: Request, write: boolean): void {
  if (write && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send JSON (Content-Type: application/json).");
}

/** Who is calling, or an error that says to sign in or to set the app up first. Null means login is off. */
function authenticate(req: Request, opts: RouteOptions, bearer: string | null): Actor | null {
  const db = getContext().db;
  if (bearer) {
    if (opts.public || opts.sessionOnly) throw new HttpError(403, "This needs a signed-in session, not an API token.", "session_required");
    const t = verifyApiToken(db, bearer);
    if (!t) throw new HttpError(401, "That API token is not valid, has expired or was revoked.", "invalid_token");
    const rate = checkRate(t.id);
    if (!rate.ok) throw new HttpError(429, "Too many requests. Slow down and retry.", "rate_limited", { "Retry-After": String(rate.retryAfter) });
    const need = opts.role ?? (opts.write ? "operator" : "viewer");
    if (!atLeast(t.role, need)) throw new HttpError(403, `This token's role (${t.role}) cannot do this; it needs ${need}.`, "forbidden");
    return { username: `token:${t.name}`, role: t.role };
  }
  const st = authState(db);
  const user = st.enabled ? userFor(req, db) : null;
  if (opts.public) return user ? { username: user.username, role: user.role } : null;
  if (st.setupRequired) throw new HttpError(401, "Tiny Snitch is waiting to be set up: create the first administrator.", "setup_required");
  if (!st.enabled) return null;
  if (!user) throw new HttpError(401, "Sign in to continue.", "auth_required");
  const need = opts.role ?? (opts.write ? "operator" : "viewer");
  if (!atLeast(user.role, need)) throw new HttpError(403, `Your role (${user.role}) cannot do this; it needs ${need}.`, "forbidden");
  return { username: user.username, role: user.role };
}

export function route(handler: (req: Request, params: RouteParams) => Promise<Response>, opts: RouteOptions = {}) {
  return async (req: Request, routeCtx?: { params?: Promise<RouteParams> }): Promise<Response> => {
    try {
      const bearer = opts.public ? null : bearerOf(req); // the sign-in and setup endpoints are for people, never for a token
      if (bearer) guardToken(req, opts.write ?? false);
      else guard(req, opts.write ?? false);
      const actor = authenticate(req, opts, bearer);
      const params = (await routeCtx?.params) ?? {};
      return await runAs(actor, () => handler(req, params));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status, headers: { "Cache-Control": "no-store", ...e.headers } });
      if (e instanceof ZodError) return json({ error: e.issues[0]?.message ?? "Invalid request." }, 400);
      const message = redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300);
      try {
        addAudit(getContext().db, { kind: "error", summary: `Unhandled error in ${new URL(req.url).pathname}`, data: { message } });
      } catch {
        /* the log itself is unavailable */
      }
      return json({ error: "Something went wrong on the server. The details are in the activity log." }, 500);
    }
  };
}
