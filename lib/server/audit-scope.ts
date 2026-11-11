import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Code that audits a tool call itself, with more context than the connection layer has (who asked, which
 * device), runs it inside this scope so the generic "system" entry is not written a second time.
 */
export const callsAuditedByCaller = new AsyncLocalStorage<true>();
