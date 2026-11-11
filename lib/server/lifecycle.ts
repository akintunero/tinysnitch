import { failInterrupted } from "../changes/store";
import { addAudit } from "../database/repo";
import { connectMcp, getContext } from "./context";

/**
 * Node-only startup work, kept out of instrumentation.ts so the Edge build never sees process signals.
 * Marks any change that a crash left half-way as failed (it cannot still be running), makes shutdown stop the MCP
 * child process instead of leaving it behind, and starts the CML connection.
 */
export function startLifecycle(): void {
  try {
    const db = getContext().db;
    const n = failInterrupted(db);
    if (n) addAudit(db, { kind: "configuration", summary: `${n} change(s) were interrupted by a restart and marked failed. Check those devices before trying again.` });
  } catch {
    /* the database is unavailable; the status page will say so */
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.race([getContext().mcp?.disconnect(), new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Windows does not pass a stop request down to child processes, so a server whose launcher was killed would keep
  // running (and keep its port). If the launcher goes away, shut down too.
  const parent = process.ppid;
  if (parent > 1) {
    const watch = setInterval(() => {
      try { process.kill(parent, 0); } catch { stop(); }
    }, 3000);
    watch.unref();
  }

  void connectMcp(true);
}
