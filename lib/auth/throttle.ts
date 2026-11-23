/**
 * Slows down password guessing. Five wrong passwords for a name lock that name for 15 minutes, and a flood of failures
 * across all names (someone spraying one password at many users) pauses every sign-in for a minute. The memory is the
 * process's own; a restart forgets it, which is acceptable for a single-instance tool.
 */
type Entry = { count: number; first: number; lockedUntil: number };
const byName = new Map<string, Entry>();
let global = { count: 0, first: 0, lockedUntil: 0 };

export const LIMITS = { perName: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, globalCount: 40, globalWindowMs: 5 * 60_000, globalLockMs: 60_000 };

/** Seconds until a sign-in for this name may be tried again, or 0 if it may be tried now. */
export function lockedFor(name: string, now = Date.now()): number {
  const e = byName.get(name.toLowerCase());
  const until = Math.max(e?.lockedUntil ?? 0, global.lockedUntil);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function recordFailure(name: string, now = Date.now()): void {
  const k = name.toLowerCase();
  const e = byName.get(k);
  const fresh = !e || now - e.first > LIMITS.windowMs;
  const next: Entry = fresh ? { count: 1, first: now, lockedUntil: 0 } : { ...e!, count: e!.count + 1 };
  if (next.count >= LIMITS.perName) next.lockedUntil = now + LIMITS.lockMs;
  byName.set(k, next);
  if (now - global.first > LIMITS.globalWindowMs) global = { count: 0, first: now, lockedUntil: 0 };
  global.count++;
  if (global.count >= LIMITS.globalCount) global.lockedUntil = now + LIMITS.globalLockMs;
  if (byName.size > 5000) for (const [key, v] of byName) if (now - v.first > LIMITS.windowMs && v.lockedUntil < now) byName.delete(key);
}

export function recordSuccess(name: string): void {
  byName.delete(name.toLowerCase());
}

/** For tests. */
export function resetThrottle(): void {
  byName.clear();
  global = { count: 0, first: 0, lockedUntil: 0 };
}
