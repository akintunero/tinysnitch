/** Runs once when the server starts. The work itself lives in lib/server/lifecycle.ts, which only the Node runtime loads. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLifecycle } = await import("./lib/server/lifecycle");
  startLifecycle();
}
