import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // Many tests talk to real sockets (fake SSH, NETCONF and HTTP servers), so give them room on a loaded machine.
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
