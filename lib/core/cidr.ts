/**
 * IPv4 ranges for allow-lists. An entry is an address or a range ("10.0.0.1", "10.0.0.0/16"). Anything that is not a
 * plain IPv4 address (a hostname, IPv6, junk) is never inside a range, because it cannot be checked.
 */
export type Range = { start: number; end: number; text: string };

const OCTET = /^(0|[1-9]\d{0,2})$/;
/** The narrowest-allowed check: a range wider than this is almost certainly a mistake for a device allow-list. */
export const WIDEST_PREFIX = 8;

export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** Returns the range, or a message saying what is wrong with the entry. */
export function parseRange(entry: string): Range | string {
  const [ip, len, extra] = entry.trim().split("/");
  if (extra !== undefined) return `"${entry}" is not an address or a range like 10.0.0.0/16.`;
  const base = ipToInt(ip);
  if (base === null) return `"${entry}" is not an IPv4 address or range like 10.0.0.0/16.`;
  const bits = len === undefined ? 32 : /^\d{1,2}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits > 32) return `"${entry}" has a prefix length that is not 0 to 32.`;
  if (bits < WIDEST_PREFIX) return `"${entry}" is wider than /${WIDEST_PREFIX}, which would allow millions of addresses. Use a range that covers only your devices.`;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1, text: entry.trim() };
}

export function inRanges(address: string | null | undefined, ranges: Range[]): boolean {
  if (!address) return false;
  const n = ipToInt(address);
  return n !== null && ranges.some((r) => n >= r.start && n <= r.end);
}
