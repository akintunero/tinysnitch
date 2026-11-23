import { generateKeyPairSync } from "node:crypto";

/**
 * One RSA host key per test process, made with Node's crypto. ssh2's own generateKeyPairSync("ed25519") occasionally
 * produces a malformed key, which made the fake SSH servers fail about one run in six.
 */
let key: string | null = null;
export function hostKeyPem(): string {
  key ??= generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
  return key;
}
