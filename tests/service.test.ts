import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpError, McpService } from "../lib/mcp/service";

/**
 * A real MCP server speaking the real protocol, in-process. It stands in for the CML server only
 * to test the connection layer; it says nothing about what CML actually exposes.
 */
function fakeServer() {
  const s = new McpServer({ name: "fake-cml", version: "9.9.9" });
  s.registerTool("get_things", { description: "list things", inputSchema: { kind: z.string() }, annotations: { readOnlyHint: true } },
    async ({ kind }) => ({ content: [{ type: "text", text: `things of ${kind}` }] }));
  s.registerTool("noargs", { description: "no arguments" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  s.registerTool("fails", { description: "reports an error" }, async () => ({ isError: true, content: [{ type: "text", text: "device unreachable" }] }));
  s.registerTool("slow", { description: "never answers in time" }, async () => { await new Promise((r) => setTimeout(r, 400)); return { content: [{ type: "text", text: "late" }] }; });
  s.registerTool("big", { description: "lots of output" }, async () => ({ content: [{ type: "text", text: "x".repeat(500) }] }));
  return s;
}

let svc: McpService | undefined;
afterEach(async () => { await svc?.disconnect(); svc = undefined; });

function connected(opts: { timeoutMs?: number; maxOutputChars?: number } = {}) {
  const server = fakeServer();
  const logs: string[] = [];
  svc = new McpService(null, {
    ...opts,
    onLog: (l) => logs.push(`${l.op}:${l.tool ?? ""}:${l.ok}`),
    transportFactory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return clientSide;
    },
  });
  return { svc, logs };
}

describe("McpService", () => {
  it("connects, reports health and discovers tools dynamically", async () => {
    const { svc } = connected();
    expect(svc.health().status).toBe("disconnected");
    await svc.connect();
    const h = svc.health();
    expect(h).toMatchObject({ status: "connected", toolCount: 5, server: { name: "fake-cml", version: "9.9.9" } });
    expect(svc.tools().map((t) => t.name).sort()).toEqual(["big", "fails", "get_things", "noargs", "slow"]);
    expect(svc.tools().find((t) => t.name === "get_things")?.classification.kind).toBe("read");
  });

  it("calls a tool and returns its text", async () => {
    const { svc, logs } = connected();
    await svc.connect();
    const r = await svc.callTool("get_things", { kind: "labs" });
    expect(r).toMatchObject({ ok: true, text: "things of labs", truncated: false });
    expect(logs).toContain("call:get_things:true");
  });

  it("validates arguments against the discovered schema before calling", async () => {
    const { svc } = connected();
    await svc.connect();
    await expect(svc.callTool("get_things", {})).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(svc.callTool("get_things", { kind: 5 })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("refuses tools the server does not have", async () => {
    const { svc } = connected();
    await svc.connect();
    await expect(svc.callTool("rm_rf", {})).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("reports a tool-level error as not ok instead of success", async () => {
    const { svc } = connected();
    await svc.connect();
    expect(await svc.callTool("fails", {})).toMatchObject({ ok: false, text: "device unreachable" });
  });

  it("times out slow tools", async () => {
    const { svc } = connected({ timeoutMs: 100 });
    await svc.connect();
    await expect(svc.callTool("slow", {})).rejects.toMatchObject({ code: "timeout" });
  });

  it("caps output size", async () => {
    const { svc } = connected({ maxOutputChars: 100 });
    await svc.connect();
    const r = await svc.callTool("big", {});
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[output truncated at 100 characters]");
  });

  it("refuses calls when not connected, and says so", async () => {
    const { svc } = connected();
    await expect(svc.callTool("noargs", {})).rejects.toBeInstanceOf(McpError);
  });

  it("can disconnect and reconnect", async () => {
    const { svc } = connected();
    await svc.connect();
    await svc.reconnect();
    expect(svc.health().status).toBe("connected");
    expect((await svc.callTool("noargs", {})).text).toBe("pong");
    await svc.disconnect();
    expect(svc.health()).toMatchObject({ status: "disconnected", toolCount: 0 });
  });

  it("reports a failed connection honestly", async () => {
    svc = new McpService({ transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [], env: {} }, { timeoutMs: 3000 });
    await expect(svc.connect()).rejects.toMatchObject({ code: "transport" });
    expect(svc.health().status).toBe("error");
    expect(svc.health().lastError).toBeTruthy();
  });
});
