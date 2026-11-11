import http from "node:http";
import https from "node:https";
import { redactSecrets } from "../security/redact";

export type ApiTarget = {
  label: string;
  host: string;
  port: number;
  username: string;
  /** Secret reference, resolved when a request is made. */
  password: string;
  /** Certificates are verified unless this is set, which is an explicit choice made in the inventory. */
  insecureTls?: boolean;
  scheme?: "https" | "http";
};

export class ApiError extends Error {
  constructor(message: string, readonly code: "auth" | "unreachable" | "timeout" | "tls" | "http" | "config") {
    super(message);
    this.name = "ApiError";
  }
}

export const isLoopback = (h: string) => /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(h);

/**
 * One JSON POST. Plain HTTP is only ever used to a loopback address (tests, a local proxy); anything else needs TLS,
 * so credentials never cross a network in clear text.
 */
export function postJson(t: ApiTarget, path: string, body: unknown, opts: { password: string; timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
  const scheme = t.scheme ?? "https";
  if (scheme === "http" && !isLoopback(t.host)) return Promise.reject(new ApiError(`${t.label}: plain HTTP is only allowed to a local address; use https.`, "config"));
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const mod = scheme === "http" ? http : https;
    const req = mod.request(
      { host: t.host, port: t.port, path, method: "POST", timeout: opts.timeoutMs ?? 30_000,
        auth: `${t.username}:${opts.password}`,
        headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(payload), ...opts.headers },
        ...(scheme === "https" ? { rejectUnauthorized: !t.insecureTls } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 8_000_000) req.destroy(new Error("response too large")); });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new ApiError(`${t.label}: login was refused (check the username and credential).`, "auth"));
          try {
            const parsed = JSON.parse(text);
            // eAPI reports command errors with a non-2xx status and a JSON body that explains them; let the caller read it.
            resolve(parsed);
          } catch {
            reject(new ApiError(`${t.label}: the device answered ${res.statusCode} with something that was not JSON${text ? `: ${redactSecrets(text).slice(0, 120)}` : ""}.`, "http"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new ApiError(`${t.label}: no answer from ${t.host}:${t.port} (timed out).`, "timeout")));
    req.on("error", (e: Error & { code?: string }) => {
      if (e instanceof ApiError) return reject(e);
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(e.code ?? e.message)) return reject(new ApiError(`${t.label}: the TLS certificate was not accepted (${e.code ?? "verify failed"}). Fix the certificate, or set insecureTls on this device in the inventory if you accept that risk.`, "tls"));
      if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(e.code ?? e.message)) return reject(new ApiError(`${t.label}: ${t.host}:${t.port} is not reachable (${e.code ?? "connection failed"}).`, "unreachable"));
      reject(new ApiError(`${t.label}: ${e.message.slice(0, 140)}`, "http"));
    });
    req.end(payload);
  });
}
