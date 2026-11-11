import type Anthropic from "@anthropic-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GET as diagGet, POST as diagPost } from "@/app/api/labs/[labId]/diagnostics/route";
import { POST as interpretPost } from "@/app/api/labs/[labId]/diagnostics/interpret/route";
import { POST as selectPost } from "@/app/api/labs/select/route";
import { checkReadOnlyCommand } from "@/lib/assistant/policy";
import { openDatabase } from "@/lib/database/db";
import { listAudit, saveSettings } from "@/lib/database/repo";
import { CMD } from "@/lib/diagnostics/commands";
import { McpService } from "@/lib/mcp/service";
import { type Ctx, getContext, setContext } from "@/lib/server/context";
import { clearTopologyCache } from "@/lib/server/topology";

const LAB = "11111111-aaaa-4aaa-8aaa-111111111111";
const G0 = "GigabitEthernet0/0";
const HEAD = "Interface                  IP-Address      OK? Method Status                Protocol\n";
const brief = (ip: string, status = "up", proto = "up") => `${HEAD}${G0.padEnd(26)} ${ip.padEnd(15)} YES manual ${status.padEnd(21)} ${proto}\n`;
const NBR = "Neighbor ID     Pri   State           Dead Time   Address         Interface\n";
const full = (id: string, addr: string) => `${NBR}${id.padEnd(15)} 1   FULL/DR         00:00:33    ${addr.padEnd(15)} ${G0}\n`;
const config = (host: string, ip: string, area: string, rid: string, secret = "") => `hostname ${host}\n${secret}!\ninterface ${G0}\n ip address ${ip} 255.255.255.252\n ip ospf 1 area ${area}\n!\nrouter ospf 1\n router-id ${rid}\n`;
const PING_OK = "Type escape sequence to abort.\n!!\nSuccess rate is 100 percent (2/2), round-trip min/avg/max = 1/1/1 ms";

type Outputs = Record<string, Record<string, string>>; // node label -> command -> output
let outputs: Outputs;
let cliCalls: { label: string; commands: string; config?: boolean }[];

const nodes = [
  { id: "n-r1", label: "R1", node_definition: "iosv", state: "BOOTED", x: 0, y: 0 },
  { id: "n-r2", label: "R2", node_definition: "iosv", state: "BOOTED", x: 200, y: 0 },
  { id: "n-r3", label: "R3", node_definition: "iosv", state: "STOPPED", x: 400, y: 0 },
  { id: "n-h", label: "H1", node_definition: "alpine", state: "BOOTED", x: 600, y: 0 },
];
const ifaces: Record<string, { id: string; label: string; is_connected: boolean }[]> = {
  "n-r1": [{ id: "i1", label: G0, is_connected: true }], "n-r2": [{ id: "i2", label: G0, is_connected: true }], "n-r3": [{ id: "i3", label: G0, is_connected: true }], "n-h": [{ id: "i4", label: "eth0", is_connected: true }],
};
const links = [
  { id: "l1", interface_a: "i1", interface_b: "i2", node_a: "n-r1", node_b: "n-r2", state: "STARTED" },
  { id: "l2", interface_a: "i3", interface_b: "i4", node_a: "n-r3", node_b: "n-h", state: "STARTED" },
];

function healthy(): Outputs {
  return {
    R1: { [CMD.brief]: brief("10.0.12.1"), [CMD.config]: config("R1", "10.0.12.1", "0", "1.1.1.1", "enable secret 9 $9$SUPERSECRETHASH\n"), [CMD.ospf]: full("2.2.2.2", "10.0.12.2"), [CMD.bgp]: "% BGP not active\n", "ping 10.0.12.2 repeat 2 timeout 1": PING_OK },
    R2: { [CMD.brief]: brief("10.0.12.2"), [CMD.config]: config("R2", "10.0.12.2", "0", "2.2.2.2"), [CMD.ospf]: full("1.1.1.1", "10.0.12.1"), [CMD.bgp]: "% BGP not active\n", "ping 10.0.12.1 repeat 2 timeout 1": PING_OK },
  };
}

function fakeCml(opts: { noCli?: boolean } = {}) {
  const s = new McpServer({ name: "fake-cml", version: "1" });
  const ro = { annotations: { readOnlyHint: true } };
  const res = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ result: v }) }] });
  s.registerTool("get_cml_labs", { description: "labs", ...ro }, async () => res([{ id: LAB, lab_title: "Test Lab", state: "STARTED" }]));
  s.registerTool("get_nodes_for_cml_lab", { description: "nodes", inputSchema: { lid: z.string() }, ...ro }, async () => res(nodes));
  s.registerTool("get_all_links_for_lab", { description: "links", inputSchema: { lid: z.string() }, ...ro }, async () => res(links));
  s.registerTool("get_interfaces_for_node", { description: "ifaces", inputSchema: { lid: z.string(), nid: z.string() }, ...ro }, async ({ nid }) => res(ifaces[nid]));
  if (!opts.noCli) {
    s.registerTool("send_cli_command", { description: "cli", inputSchema: { lid: z.string(), label: z.string(), commands: z.string(), config_command: z.boolean().optional() } }, async (a) => {
      cliCalls.push({ label: a.label, commands: a.commands, config: a.config_command });
      const text = outputs[a.label]?.[a.commands];
      return text === undefined ? { isError: true, content: [{ type: "text" as const, text: "% Invalid input detected at '^' marker." }] } : { content: [{ type: "text" as const, text }] };
    });
  }
  return s;
}

type Reply = Pick<Anthropic.Message, "content" | "stop_reason">;
const claude = (replies: Reply[]) => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return { client: { messages: { create: async (p: Anthropic.MessageCreateParamsNonStreaming) => { seen.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (!r) throw new Error("Claude was called but the script is empty"); return { id: "m", type: "message", role: "assistant", model: "t", stop_sequence: null, usage: {}, ...r } as unknown as Anthropic.Message; } } } as unknown as Anthropic, seen };
};
const text = (t: string): Reply => ({ stop_reason: "end_turn", content: [{ type: "text", text: t, citations: null } as Anthropic.TextBlock] });

function install(opts: { noCli?: boolean; anthropic?: Anthropic } = {}) {
  outputs = healthy();
  cliCalls = [];
  clearTopologyCache();
  const server = fakeCml(opts);
  const mcp = new McpService(null, { transportFactory: () => { const [a, b] = InMemoryTransport.createLinkedPair(); void server.connect(b); return a; } });
  const ctx: Ctx = { db: openDatabase(":memory:"), mcp, mcpConfig: null, mcpConfigError: null, lastConnectAttempt: 0, anthropic: opts.anthropic ?? null,
    claude: { configured: !!opts.anthropic, model: "test-model", configError: opts.anthropic ? null : "Missing ANTHROPIC_API_KEY.", verification: "unverified", checkedAt: null, error: null } };
  setContext(ctx);
  return ctx;
}

const url = (p: string) => `http://localhost:3000${p}`;
const P = `/api/labs/${LAB}/diagnostics`;
const idc = (labId = LAB) => ({ params: Promise.resolve({ labId }) });
const post = (p: string, body: unknown = {}) => new Request(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runIt = async (body: unknown = {}) => { const r = await diagPost(post(P, body), idc()); return { status: r.status, body: await r.json() }; };
const latest = async () => (await diagGet(new Request(url(P)), idc())).json();

beforeEach(() => { install(); });
afterEach(async () => { await getContext().mcp?.disconnect(); clearTopologyCache(); setContext(undefined); });

describe("running diagnostics", () => {
  it("inspects running routers, skips the rest with a reason, and finds nothing wrong on a healthy lab", async () => {
    const { status, body } = await runIt();
    expect(status).toBe(200);
    expect(body.findings).toEqual([]);
    const byLabel = Object.fromEntries(body.run.devices.map((d: { label: string }) => [d.label, d]));
    expect(byLabel.R1).toMatchObject({ inspected: true, commandsRun: 4, commandsFailed: 0 });
    expect(byLabel.R3).toMatchObject({ inspected: false, reason: expect.stringMatching(/Not running/) });
    expect(byLabel.H1).toMatchObject({ inspected: false, reason: expect.stringMatching(/Not an IOS router or switch/) });
    expect(body.run.notRun.join()).toMatch(/routing loops/);
    // Both ends reported up/up and the ping succeeded, so the topology may show it as operational.
    expect(body.links.l1).toMatchObject({ status: "operational", text: expect.stringMatching(/ping between them succeeded/) });
    expect(body.links.l2).toBeUndefined();
  });

  it("only ever sends read-only commands and never config mode", async () => {
    await runIt();
    expect(cliCalls.length).toBeGreaterThan(8);
    for (const c of cliCalls) {
      expect(checkReadOnlyCommand(c.commands)).toEqual({ ok: true });
      expect(c.config).toBeFalsy();
    }
    expect(cliCalls.map((c) => c.label)).not.toContain("R3"); // stopped nodes are never contacted
    expect(cliCalls.map((c) => c.label)).not.toContain("H1");
  });

  it("finds an OSPF area mismatch, quotes the evidence, and flags the device and link", async () => {
    outputs.R2[CMD.config] = config("R2", "10.0.12.2", "1", "2.2.2.2");
    outputs.R1[CMD.ospf] = NBR; outputs.R2[CMD.ospf] = NBR;
    const { body } = await runIt();
    expect(body.findings).toHaveLength(1);
    const f = body.findings[0];
    expect(f).toMatchObject({ kind: "ospf-adjacency-missing", status: "confirmed", severity: "critical", device: "R1" });
    expect(f.probableCause).toMatch(/area mismatch/);
    expect(f.evidence.some((e: string) => e.startsWith(`R2# ${CMD.config}`))).toBe(true);
    expect(body.links.l1).toEqual({ status: "fault", text: "OSPF adjacency missing" });
    expect(body.nodeFaults).toEqual({ "n-r1": "error" });
  });

  it("keeps finding identity across runs, then reports a fixed problem as cleared", async () => {
    outputs.R2[CMD.brief] = brief("10.0.12.2", "administratively down", "down");
    outputs.R1[CMD.brief] = brief("10.0.12.1", "down", "down");
    const first = await runIt();
    expect(first.body.opened).toBe(2);
    const again = await runIt();
    expect(again.body.opened).toBe(0);
    expect(again.body.findings.map((f: { id: string }) => f.id).sort()).toEqual(first.body.findings.map((f: { id: string }) => f.id).sort());
    expect(again.body.findings[0].firstSeen).toBe(first.body.findings[0].firstSeen);

    outputs.R2[CMD.brief] = brief("10.0.12.2"); outputs.R1[CMD.brief] = brief("10.0.12.1");
    const fixed = await runIt();
    expect(fixed.body.findings).toEqual([]);
    expect(fixed.body.cleared).toBe(2);
    expect((await latest()).findings).toEqual([]);
  });

  it("does not ping links that are not up/up, and reports a failed ping as confirmed", async () => {
    outputs.R1[CMD.brief] = brief("10.0.12.1", "up", "down");
    await runIt();
    expect(cliCalls.some((c) => c.commands.startsWith("ping"))).toBe(false);
    outputs.R1[CMD.brief] = brief("10.0.12.1");
    outputs.R1["ping 10.0.12.2 repeat 2 timeout 1"] = ".. \nSuccess rate is 0 percent (0/2)";
    const { body } = await runIt();
    expect(body.findings.find((f: { kind: string }) => f.kind === "ping-failed")).toMatchObject({ status: "confirmed", device: "R1" });
    expect(body.links.l1.status).toBe("fault");
  });

  it("can skip pings", async () => {
    await runIt({ pings: false });
    expect(cliCalls.some((c) => c.commands.startsWith("ping"))).toBe(false);
  });

  it("reports failed commands per device instead of hiding them, and concludes nothing from them", async () => {
    delete outputs.R2[CMD.ospf]; delete outputs.R2[CMD.bgp];
    const { body } = await runIt();
    const r2 = body.run.devices.find((d: { label: string }) => d.label === "R2");
    expect(r2).toMatchObject({ inspected: true, commandsFailed: 2 });
    expect(body.findings).toEqual([]);
  });

  it("marks a device not inspected when every command fails", async () => {
    outputs.R2 = {};
    const { body } = await runIt({ pings: false });
    expect(body.run.devices.find((d: { label: string }) => d.label === "R2")).toMatchObject({ inspected: false, reason: expect.stringMatching(/^Every command failed\./) });
  });

  it("never stores device secrets", async () => {
    await runIt();
    const stored = JSON.stringify(await latest()) + JSON.stringify(listAudit(getContext().db));
    expect(stored).not.toContain("SUPERSECRETHASH");
  });

  it("says plainly when the server has no CLI tool", async () => {
    await getContext().mcp?.disconnect();
    install({ noCli: true });
    const { status, body } = await runIt();
    expect(status).toBe(501);
    expect(body.code).toBe("capability_missing");
  });

  it("refuses a second concurrent run and a malformed lab id", async () => {
    const [a, b] = await Promise.all([runIt(), runIt()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await diagPost(post("/api/labs/x/diagnostics"), idc("../etc"))).status).toBe(400);
    expect((await diagGet(new Request(url(P)), idc("a b"))).status).toBe(400);
  });

  it("records the run in the audit log", async () => {
    await runIt();
    expect(listAudit(getContext().db).some((e) => e.kind === "diagnostic" && /2 of 4 devices inspected, 0 findings/.test(e.summary))).toBe(true);
  });

  it("returns an empty state before any run", async () => {
    expect(await latest()).toMatchObject({ run: null, findings: [], links: {}, nodeFaults: {} });
  });

  it("refuses cross-origin runs", async () => {
    const r = await diagPost(new Request(url(P), { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" }), idc());
    expect(r.status).toBe(403);
  });
});

describe("interpretation", () => {
  const withFinding = async (ctx: Ctx) => {
    outputs.R2[CMD.config] = config("R2", "10.0.12.2", "1", "2.2.2.2");
    outputs.R1[CMD.ospf] = NBR; outputs.R2[CMD.ospf] = NBR;
    expect((await runIt()).body.findings).toHaveLength(1);
    return ctx;
  };

  it("hands Claude the findings and their evidence, masked, and stores its explanation", async () => {
    const { client, seen } = claude([text("R1 and R2 disagree about the OSPF area. Confirmed. Fix R2.")]);
    await getContext().mcp?.disconnect();
    const ctx = install({ anthropic: client });
    await withFinding(ctx);
    const r = await interpretPost(post(`${P}/interpret`), idc());
    expect(r.status).toBe(200);
    expect((await r.json()).text).toMatch(/OSPF area/);
    expect(seen).toHaveLength(1);
    const sent = JSON.stringify(seen[0]);
    expect(sent).toContain("OSPF adjacency missing");
    expect(sent).toContain("R2# show running-config: GigabitEthernet0/0 in area 1"); // the evidence travels with the finding
    expect(sent).toContain("untrusted");
    expect(sent).not.toContain("SUPERSECRETHASH");
    expect(JSON.stringify(seen[0].system)).toMatch(/Do not report any problem that is not in the findings/);
    expect(seen[0].tools).toBeUndefined(); // explaining needs no tools, so Claude gets none
    expect((await latest()).run.interpretation).toMatch(/OSPF area/);
  });

  it("does not call Claude when there is nothing to explain, and says what was not checked", async () => {
    const { client, seen } = claude([]);
    await getContext().mcp?.disconnect();
    install({ anthropic: client });
    await runIt();
    const r = await interpretPost(post(`${P}/interpret`), idc());
    const { text: t } = await r.json();
    expect(seen).toHaveLength(0);
    expect(t).toMatch(/no problems/);
    expect(t).toMatch(/routing loops/);
    expect(t).toMatch(/not proof the network is healthy/);
  });

  it("says nothing was checked, rather than all clear, when no device could be read", async () => {
    const { client, seen } = claude([]);
    await getContext().mcp?.disconnect();
    install({ anthropic: client });
    for (const n of nodes) n.state = "STOPPED";
    try {
      await runIt();
      const { text: t } = await (await interpretPost(post(`${P}/interpret`), idc())).json();
      expect(t).toMatch(/Nothing was checked/);
      expect(t).toMatch(/says nothing about the network's health/);
      expect(t).not.toMatch(/found no problems/);
      expect(seen).toHaveLength(0);
    } finally {
      nodes[0].state = "BOOTED"; nodes[1].state = "BOOTED"; nodes[2].state = "STOPPED"; nodes[3].state = "BOOTED";
    }
  });

  it("needs a run first, and Claude to be configured when there is something to explain", async () => {
    expect((await interpretPost(post(`${P}/interpret`), idc())).status).toBe(404);
    await withFinding(getContext());
    const r = await interpretPost(post(`${P}/interpret`), idc());
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("claude_unavailable");
  });

  it("reports a Claude failure readably", async () => {
    const failing = { messages: { create: async () => { throw new Error("socket hang up sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV"); } } } as unknown as Anthropic;
    await getContext().mcp?.disconnect();
    const ctx = install({ anthropic: failing });
    await withFinding(ctx);
    const r = await interpretPost(post(`${P}/interpret`), idc());
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("ABCDEFGHIJKLMNOP");
  });
});

describe("diagnostics on lab selection", () => {
  it("runs in the background when the user opted in, and not otherwise", async () => {
    await selectPost(post("/api/labs/select", { id: LAB }));
    await new Promise((r) => setTimeout(r, 200));
    expect(cliCalls).toEqual([]);

    saveSettings(getContext().db, { diagnosticsOnLabSelect: true });
    expect((await selectPost(post("/api/labs/select", { id: LAB }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(cliCalls.length).toBeGreaterThan(0);
    expect((await latest()).run).not.toBeNull();
  });
});
