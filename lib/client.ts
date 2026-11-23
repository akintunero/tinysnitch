"use client";

export class ClientError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  let data: { error?: string; code?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new ClientError(data?.error ?? `Request failed (${res.status})`, res.status, data?.code);
  return data as T;
}

export const apiGet = <T,>(path: string) => request<T>("GET", path);
export const apiSend = <T,>(method: "POST" | "PUT" | "DELETE", path: string, body: unknown = {}) => request<T>(method, path, body);
