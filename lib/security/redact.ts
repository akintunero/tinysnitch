/** Strips credentials from text before it is stored in the audit log or shown in an error. */
const RULES: [RegExp, string][] = [
  [/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/((?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1***"],
  [/\b(enable\s+(?:secret|password)\s+)(?:\d\s+)?\S+/gi, "$1***"],
  [/\b(username\s+\S+\s+(?:privilege\s+\d+\s+)?(?:secret|password)\s+)(?:\d\s+)?\S+/gi, "$1***"],
  [/\b(snmp-server\s+community\s+)\S+/gi, "$1***"],
  [/\b(key-string\s+)(?:\d\s+)?\S+/gi, "$1***"],
];

export function redactSecrets(text: string): string {
  return RULES.reduce((s, [re, sub]) => s.replace(re, sub), text);
}

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|credential)/i;

/** Redacts every string inside a value and masks the value of any secret-looking key. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "***" : redactDeep(v, depth + 1)]),
  );
}
