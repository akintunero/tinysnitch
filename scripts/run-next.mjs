// Runs `next dev` or `next start` on APP_HOST:APP_PORT (default 127.0.0.1:3000), reading .env.local first.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) {
  console.error("usage: node scripts/run-next.mjs <dev|start>");
  process.exit(2);
}
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const port = process.env.APP_PORT || "3000";
const host = (process.env.APP_HOST || "127.0.0.1").trim();
const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const args = [decodeURIComponent(bin), mode, "-H", host, "-p", port];

// Listening beyond loopback is meant for a container whose port is published to the host's loopback, or for a server
// behind TLS. The app then starts closed: it needs a first administrator before it answers anything.
if (!/^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(host)) {
  console.error(`Note: listening on ${host}. The app stays closed until the first administrator is created (setup token below); put TLS in front of it before exposing it beyond a trusted network.`);
}

// Lets a test check the arguments without starting a server.
if (process.env.RUN_NEXT_DRY === "1") {
  console.log(JSON.stringify({ host, port, mode }));
  process.exit(0);
}

const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
// Pass a stop request on to Next, which closes the MCP child before it exits.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
