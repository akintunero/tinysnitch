import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GET as activity } from "@/app/api/activity/route";
import { POST as verifyClaudeRoute } from "@/app/api/claude/verify/route";
import { GET as labsGet } from "@/app/api/labs/route";
import { POST as labsSelect } from "@/app/api/labs/select/route";
import { POST as reconnect } from "@/app/api/mcp/reconnect/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/settings/route";
import { GET as status } from "@/app/api/status/route";
import { GET as tools } from "@/app/api/tools/route";
import { openDatabase } from "@/lib/database/db";
import { addAudit } from "@/lib/database/repo";
import { type Ctx, setContext } from "@/lib/server/context";
import { McpService } from "@/lib/mcp/service";

const SECRET = "Basic c3VwZXJzZWNyZXRjcmVkcw==";
const LABS = [
  { id: "lab-1", lab_title: "Alpha", state: "STARTED", node_count: 3, link_count: 2, owner_username: "admin", lab_description: "" },
  { id: "lab-2", lab_title: "Beta", state: "DEFINED_ON_CORE", node_count: 5, link_count: 4, owner_username: "admin", lab_description: "second" },
];

/** A real MCP server over the real protocol, in-process. It stands in for CML only to test our API layer. */
function fakeCml(opts: { labs?: unknown; withListLabs?: boolean } = {}) {
  const s = new McpServer({ name: "fake-cml", version: "1.0.0" });
  if (opts.withListLabs !== false) {
    s.registerTool("get_cml_labs", { description: "labs", annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ result: opts.labs ?? LABS }) }],
    }));
  }
  s.registerTool("send_cli_command", { description: "cli", inputSchema: { lid: z.string(), label: z.string(), commands: z.string(), config_command: z.boolean().optional() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return s;
}

function install(opts: Parameters<typeof fakeCml>[0] = {}, claude: Partial<Ctx["claude"]> = {}) {
  const db = openDatabase(":memory:");
  const server = fakeCml(opts);
  const mcp = new McpService(null, {
    transportFactory: () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      void server.connect(b);
      return a;
    },
  });
  const ctx: Ctx = {
    db, mcp, mcpConfig: null, mcpConfigError: null, anthropic: null, lastConnectAttempt: 0,
    claude: { configured: false, model: null, configError: "Missing ANTHROPIC_API_KEY.", verification: "unverified", checkedAt: null, error: null, ...claude },
  };
  setContext(ctx);
  return ctx;
}

const url = (p: string) => `http://localhost:3000${p}`;
const get = (p: string, headers: Record<string, string> = {}) => new Request(url(p), { headers });
const send = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url(p), { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => { install(); });
afterEach(async () => { await (await import("@/lib/server/context")).getContext().mcp?.disconnect(); setContext(undefined); });

describe("status", () => {
  it("starts a connection on demand and reports health honestly once it is up", async () => {
    await status(get("/api/status")); // kicks the connection off without waiting for it
    await vi.waitFor(async () => expect((await (await status(get("/api/status"))).json()).mcp.status).toBe("connected"));
    const body = await (await status(get("/api/status"))).json();
    expect(body.mcp).toMatchObject({ status: "connected", toolCount: 2, configured: true, server: { name: "fake-cml" } });
    expect(body.claude).toMatchObject({ configured: false, verification: "unverified" });
  });
  it("reports a missing MCP configuration instead of pretending", async () => {
    setContext({ ...install(), mcp: null, mcpConfigError: "Set CML_MCP_TRANSPORT to stdio or http." });
    const body = await (await status(get("/api/status"))).json();
    expect(body.mcp).toMatchObject({ configured: false, status: "disconnected", configError: "Set CML_MCP_TRANSPORT to stdio or http." });
  });
});

describe("status never blocks on a slow connection", () => {
  it("answers immediately while a connection is still in progress, and routes then join it", async () => {
    const ctx = install();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const server = fakeCml();
    ctx.mcp = new McpService(null, {
      transportFactory: () => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        void gate.then(() => server.connect(b));
        return a;
      },
    });
    const started = Date.now();
    const body = await (await status(get("/api/status"))).json();
    expect(Date.now() - started).toBeLessThan(500);
    expect(body.mcp.status).toBe("connecting");
    const labsCall = labsGet(get("/api/labs")); // must wait for the same attempt, not fail with 503
    release();
    expect((await labsCall).status).toBe(200);
  });
});

describe("labs", () => {
  it("lists labs with totals computed in code", async () => {
    const body = await (await labsGet(get("/api/labs"))).json();
    expect(body.labs.map((l: { title: string }) => l.title)).toEqual(["Alpha", "Beta"]);
    expect(body.totals).toEqual({ labs: 2, running: 1, nodes: 8, links: 6 });
  });
  it("returns 503 with the reason when the MCP server is unavailable", async () => {
    setContext({ ...install(), mcp: null, mcpConfigError: "not configured" });
    const r = await labsGet(get("/api/labs"));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "mcp_unavailable", error: "not configured" });
  });
  it("says so when the server has no lab-listing tool", async () => {
    install({ withListLabs: false });
    const r = await labsGet(get("/api/labs"));
    expect(r.status).toBe(501);
    expect((await r.json()).code).toBe("capability_missing");
  });
  it("refuses a reply it cannot parse rather than guessing", async () => {
    install({ labs: [{ nope: 1 }] });
    const r = await labsGet(get("/api/labs"));
    expect(r.status).toBe(502);
  });
  it("stores a selection only for a lab CML really has", async () => {
    const ok = await labsSelect(send("POST", "/api/labs/select", { id: "lab-2" }));
    expect(await ok.json()).toEqual({ selectedLabId: "lab-2", selectedLabTitle: "Beta" });
    expect((await (await settingsGet(get("/api/settings"))).json()).selectedLabTitle).toBe("Beta");
    expect((await labsSelect(send("POST", "/api/labs/select", { id: "made-up" }))).status).toBe(404);
    expect((await labsSelect(send("POST", "/api/labs/select", { id: null }))).status).toBe(200);
  });
});

describe("tools", () => {
  it("lists discovered tools with classification and resolved capabilities", async () => {
    const body = await (await tools(get("/api/tools"))).json();
    const cli = body.tools.find((t: { name: string }) => t.name === "send_cli_command");
    expect(cli.kind).toBe("mixed");
    expect(body.capabilities.listLabs.tool).toBe("get_cml_labs");
    expect(body.capabilities.getLabNodes.tool).toBeNull();
    expect(body.capabilities.runCommand.tool).toBe("send_cli_command");
  });
});

describe("settings", () => {
  it("defaults to approve mode and persists changes with an audit entry", async () => {
    expect((await (await settingsGet(get("/api/settings"))).json()).executionMode).toBe("approve");
    const r = await settingsPut(send("PUT", "/api/settings", { executionMode: "suggest", snapshotBeforeChange: false }));
    expect(await r.json()).toMatchObject({ executionMode: "suggest", snapshotBeforeChange: false });
    const events = (await (await activity(get("/api/activity"))).json()).events;
    expect(events[0]).toMatchObject({ kind: "settings", actor: "user" });
  });
  it("changing one setting leaves every other setting alone", async () => {
    await labsSelect(send("POST", "/api/labs/select", { id: "lab-2" }));
    await settingsPut(send("PUT", "/api/settings", { snapshotBeforeChange: false, diagnosticsOnLabSelect: true }));
    const r = await settingsPut(send("PUT", "/api/settings", { executionMode: "suggest" }));
    expect(await r.json()).toMatchObject({
      executionMode: "suggest", snapshotBeforeChange: false, diagnosticsOnLabSelect: true, selectedLabId: "lab-2", selectedLabTitle: "Beta",
    });
    const audit = (await (await activity(get("/api/activity"))).json()).events[0];
    expect(audit.summary).toBe("Changed settings: executionMode");
  });
  it("rejects unknown fields, bad values and non-JSON", async () => {
    expect((await settingsPut(send("PUT", "/api/settings", { executionMode: "yolo" }))).status).toBe(400);
    expect((await settingsPut(send("PUT", "/api/settings", { anthropicKey: "x" }))).status).toBe(400);
    expect((await settingsPut(new Request(url("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: "{nope" }))).status).toBe(400);
  });
});

describe("claude verification", () => {
  it("fails clearly when Claude is not configured", async () => {
    const r = await verifyClaudeRoute(send("POST", "/api/claude/verify", {}));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ verification: "error", error: "Missing ANTHROPIC_API_KEY." });
  });
});

describe("reconnect", () => {
  it("drops and re-establishes the connection and audits it", async () => {
    await labsGet(get("/api/labs")); // connects (and waits)
    const r = await reconnect(send("POST", "/api/mcp/reconnect", {}));
    expect(await r.json()).toMatchObject({ status: "connected", toolCount: 2 });
    const kinds = (await (await activity(get("/api/activity"))).json()).events.map((e: { summary: string }) => e.summary);
    expect(kinds).toContain("Reconnect requested");
  });
});

describe("security guards", () => {
  it("answers only on loopback hosts", async () => {
    expect((await status(get("/api/status", { host: "evil.example" }))).status).toBe(403);
    expect((await status(get("/api/status", { host: "127.0.0.1:3000" }))).status).toBe(200);
  });
  it("rejects cross-origin and cross-site writes", async () => {
    const body = { executionMode: "suggest" };
    expect((await settingsPut(send("PUT", "/api/settings", body, { origin: "http://evil.example" }))).status).toBe(403);
    expect((await settingsPut(send("PUT", "/api/settings", body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await settingsPut(send("PUT", "/api/settings", body, { origin: "http://localhost:3000" }))).status).toBe(200);
  });
  it("requires JSON on writes", async () => {
    const r = await settingsPut(new Request(url("/api/settings"), { method: "PUT", headers: { "content-type": "text/plain" }, body: "x" }));
    expect(r.status).toBe(415);
  });
  it("never puts credentials in any response or in the activity log", async () => {
    const ctx = install();
    ctx.mcpConfig = { transport: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://cml/mcp", "--header", "X-Authorization:${CML_AUTH_HEADER}"], env: { CML_AUTH_HEADER: SECRET } };
    addAudit(ctx.db, { kind: "error", summary: `failed with ${SECRET}`, data: { header: SECRET } });
    const bodies = [
      await (await status(get("/api/status"))).text(),
      await (await tools(get("/api/tools"))).text(),
      await (await settingsGet(get("/api/settings"))).text(),
      await (await activity(get("/api/activity"))).text(),
    ];
    for (const b of bodies) {
      expect(b).not.toContain("c3VwZXJzZWNyZXRjcmVkcw");
      expect(b).not.toMatch(/sk-ant-/);
    }
    expect(bodies[0]).toContain("CML_AUTH_HEADER"); // the variable name is shown, never its value
  });
});
