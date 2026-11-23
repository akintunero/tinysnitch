// Runs `next dev` or `next start` bound to loopback on APP_PORT (default 3000), reading .env.local first.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) {
  console.error("usage: node scripts/run-next.mjs <dev|start>");
  process.exit(2);
}
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const port = process.env.APP_PORT || "3000";
const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const child = spawn(process.execPath, [decodeURIComponent(bin), mode, "-H", "127.0.0.1", "-p", port], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
// Pass a stop request on to Next, which closes the MCP child before it exits.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
