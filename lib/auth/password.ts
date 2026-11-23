import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

// scrypt, 16 MiB of memory per hash: slow enough to make guessing expensive, light enough for a small server.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/** `scrypt$N$r$p$salt$hash`, base64. The parameters are stored so they can be raised later without locking anyone out. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "base64");
    const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Checked against when a username does not exist, so a wrong user and a wrong password take the same time. */
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(12).toString("hex")));

const COMMON = new Set(["password1234", "passwordpassword", "123456789012", "qwertyuiop12", "administrator", "changemechangeme", "letmein12345", "iloveyou1234"]);

/** A password is acceptable if it is long, and not an obvious one. No composition rules: length is what helps. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  if (new Set(password).size < 5) return "That password repeats too few different characters.";
  if (COMMON.has(password.toLowerCase())) return "That is a very common password.";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "The password must not contain the username.";
  return null;
}
