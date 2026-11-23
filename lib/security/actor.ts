import { AsyncLocalStorage } from "node:async_hooks";
import type { Role } from "../auth/roles";

/** Who is making the request being handled, so the audit log names a person and not just "user". Null when login is off. */
export type Actor = { username: string; role: Role };

const store = new AsyncLocalStorage<Actor | null>();

export const runAs = <T>(actor: Actor | null, fn: () => T): T => store.run(actor, fn);
export const currentActor = (): Actor | null => store.getStore() ?? null;
/** `user:alice` when someone is signed in, otherwise the plain "user" used before login existed. */
export const actorName = (): string => {
  const a = currentActor();
  return a ? `user:${a.username}` : "user";
};
