import { readFileSync } from "node:fs";

/**
 * Credentials are never written in an inventory file. A file says where a secret lives (`env:NAME` or `file:/path`)
 * and the value is read only at the moment it is used, then dropped. Nothing here is logged.
 */
export const SECRET_REF = /^(env|file):\S.*$/;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

export function isSecretRef(v: string): boolean {
  return SECRET_REF.test(v);
}

export type Env = Record<string, string | undefined>;

export function resolveSecret(ref: string, env: Env = process.env): string {
  const m = ref.match(/^(env|file):(.+)$/);
  if (!m) throw new SecretError("A secret must be given as env:NAME or file:/path, never written into the file.");
  if (m[1] === "env") {
    const v = env[m[2]];
    if (!v) throw new SecretError(`The environment variable ${m[2]} is not set.`);
    return v;
  }
  try {
    return readFileSync(m[2], "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new SecretError(`The secret file ${m[2]} could not be read.`);
  }
}
