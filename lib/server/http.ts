import { ZodError, type ZodType } from "zod";
import { addAudit } from "../database/repo";
import { redactSecrets } from "../security/redact";
import { getContext } from "./context";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
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
export function route(handler: (req: Request, params: RouteParams) => Promise<Response>, opts: { write?: boolean } = {}) {
  return async (req: Request, routeCtx?: { params?: Promise<RouteParams> }): Promise<Response> => {
    try {
      guard(req, opts.write ?? false);
      return await handler(req, (await routeCtx?.params) ?? {});
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
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
