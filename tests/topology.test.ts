import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DELETE as positionsDelete, GET as positionsGet, PUT as positionsPut } from "@/app/api/labs/[labId]/positions/route";
import { GET as topologyGet } from "@/app/api/labs/[labId]/topology/route";
import { bindArgs, resolveCapabilities } from "@/lib/cml/capabilities";
import { classifyNode } from "@/lib/cml/node-types";
import { cmlLinkStatus } from "@/lib/cml/topology";
import { openDatabase } from "@/lib/database/db";
import { McpService } from "@/lib/mcp/service";
import { type Ctx, getContext, setContext } from "@/lib/server/context";
import { clearTopologyCache } from "@/lib/server/topology";

const LAB = "11111111-aaaa-4aaa-8aaa-111111111111";
const labs = [{ id: LAB, lab_title: "Test Lab", state: "STARTED", node_count: 3, link_count: 3, owner_username: "admin", lab_description: "" }];
const nodes = [
  { id: "n-r1", label: "R1", node_definition: "iosv", state: "BOOTED", boot_progress: "Booted", x: -300, y: -100 },
  { id: "n-sw", label: "SW1", node_definition: "iosvl2", state: "BOOTED", boot_progress: "Booted", x: 0, y: -100 },
  { id: "n-h1", label: "H1", node_definition: "alpine", state: "STOPPED", boot_progress: "Not running", x: 300, y: -100 },
];
const ifaces: Record<string, { id: string; label: string; is_connected: boolean; ip4?: string[] }[]> = {
  "n-r1": [{ id: "i-r1-0", label: "GigabitEthernet0/0", is_connected: true, ip4: ["10.0.0.1/24"] }, { id: "i-r1-1", label: "GigabitEthernet0/1", is_connected: true }, { id: "i-r1-lo", label: "Loopback0", is_connected: false }],
  "n-sw": [{ id: "i-sw-0", label: "GigabitEthernet0/0", is_connected: true }, { id: "i-sw-1", label: "GigabitEthernet0/1", is_connected: true }, { id: "i-sw-2", label: "GigabitEthernet0/2", is_connected: true }],
  "n-h1": [{ id: "i-h1-0", label: "eth0", is_connected: true }],
};
// Link labels are deliberately stale (CML keeps old names after renames); interface ids are the truth.
const links = [
  { id: "l1", label: "stale-1", interface_a: "i-r1-0", interface_b: "i-sw-0", node_a: "n-r1", node_b: "n-sw", state: "STARTED" },
  { id: "l2", label: "stale-2", interface_a: "i-r1-1", interface_b: "i-sw-1", node_a: "n-r1", node_b: "n-sw", state: "STARTED" },
  { id: "l3", label: "stale-3", interface_a: "i-sw-2", interface_b: "i-h1-0", node_a: "n-sw", node_b: "n-h1", state: "STOPPED" },
];

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ result: v }) }] });

function fakeCml(opts: { noLinksTool?: boolean; failInterfacesFor?: string } = {}) {
  const calls: string[] = [];
  const s = new McpServer({ name: "fake-cml", version: "1" });
  const ro = { annotations: { readOnlyHint: true } };
  s.registerTool("get_cml_labs", { description: "labs", ...ro }, async () => { calls.push("labs"); return text(labs); });
  s.registerTool("get_nodes_for_cml_lab", { description: "nodes", inputSchema: { lid: z.string() }, ...ro }, async () => { calls.push("nodes"); return text(nodes); });
  if (!opts.noLinksTool) s.registerTool("get_all_links_for_lab", { description: "links", inputSchema: { lid: z.string() }, ...ro }, async () => { calls.push("links"); return text(links); });
  s.registerTool("get_interfaces_for_node", { description: "ifaces", inputSchema: { lid: z.string(), nid: z.string() }, ...ro }, async ({ nid }) => {
    calls.push(`ifaces:${nid}`);
    if (nid === opts.failInterfacesFor) return { isError: true, content: [{ type: "text" as const, text: "node not booted" }] };
    return text(ifaces[nid]);
  });
  return { s, calls };
}

function install(opts: Parameters<typeof fakeCml>[0] = {}) {
  const { s, calls } = fakeCml(opts);
  const mcp = new McpService(null, { transportFactory: () => { const [a, b] = InMemoryTransport.createLinkedPair(); void s.connect(b); return a; } });
  const ctx: Ctx = { db: openDatabase(":memory:"), mcp, mcpConfig: null, mcpConfigError: null, anthropic: null, lastConnectAttempt: 0,
    claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null } };
  setContext(ctx);
  clearTopologyCache();
  return calls;
}

const url = (p: string) => `http://localhost:3000${p}`;
const get = (p: string) => new Request(url(p));
const send = (method: string, p: string, body?: unknown) => new Request(url(p), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctxFor = (labId: string) => ({ params: Promise.resolve({ labId }) });

let calls: string[];
beforeEach(() => { calls = install(); });
afterEach(async () => { await getContext().mcp?.disconnect(); setContext(undefined); clearTopologyCache(); });

describe("topology", () => {
  it("returns the lab's real nodes, links and interfaces", async () => {
    const r = await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB));
    expect(r.status).toBe(200);
    const t = await r.json();
    expect(t.lab).toEqual({ id: LAB, title: "Test Lab", state: "STARTED", environment: "lab", providerId: "cml" });
    expect(t.nodes.map((n: { label: string; kind: string }) => `${n.label}:${n.kind}`)).toEqual(["R1:router", "SW1:l2switch", "H1:host"]);
    expect(t.nodes[0]).toMatchObject({ x: -300, y: -100, state: "BOOTED" });
    expect(t.nodes[0].interfaces).toHaveLength(3);
    expect(t.nodes[0].interfaces[0]).toMatchObject({ label: "GigabitEthernet0/0", connected: true, ips: ["10.0.0.1/24"] });
    expect(t.nodes[0].interfaces[2]).toMatchObject({ label: "Loopback0", connected: false, ips: [] });
    expect(t.warnings).toEqual([]);
  });

  it("names link ends from interface ids, not CML's stale link labels", async () => {
    const t = await (await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB))).json();
    expect(t.links[0]).toMatchObject({ source: "n-r1", target: "n-sw", sourceInterface: "GigabitEthernet0/0", targetInterface: "GigabitEthernet0/0" });
    expect(t.links[1]).toMatchObject({ sourceInterface: "GigabitEthernet0/1", targetInterface: "GigabitEthernet0/1" }); // parallel link
    expect(JSON.stringify(t)).not.toContain("stale");
  });

  it("never calls a started link operational", async () => {
    const t = await (await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB))).json();
    expect(t.links.map((l: { status: string }) => l.status)).toEqual(["not_inspected", "not_inspected", "admin_down"]);
    expect(t.links[0].statusText).toMatch(/not inspected/i);
  });

  it("caches for a few seconds and refresh bypasses the cache", async () => {
    await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB));
    const first = calls.length;
    await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB));
    expect(calls.length).toBe(first);
    await topologyGet(get(`/api/labs/${LAB}/topology?refresh=1`), ctxFor(LAB));
    expect(calls.length).toBeGreaterThan(first);
  });

  it("keeps going and warns when one node's interfaces can't be read", async () => {
    await getContext().mcp?.disconnect();
    calls = install({ failInterfacesFor: "n-h1" });
    const t = await (await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB))).json();
    expect(t.nodes).toHaveLength(3);
    expect(t.warnings.join()).toMatch(/H1/);
    expect(t.links[2].targetInterface).toBe("unknown interface");
  });

  it("404s a lab CML does not have and 400s a malformed id", async () => {
    expect((await topologyGet(get("/api/labs/22222222-bbbb-4bbb-8bbb-222222222222/topology"), ctxFor("22222222-bbbb-4bbb-8bbb-222222222222"))).status).toBe(404);
    expect((await topologyGet(get("/api/labs/x/topology"), ctxFor("../../etc/passwd"))).status).toBe(400);
    expect((await topologyGet(get("/api/labs/x/topology"), ctxFor("a b"))).status).toBe(400);
  });

  it("says plainly when the server has no tool for links", async () => {
    await getContext().mcp?.disconnect();
    install({ noLinksTool: true });
    const r = await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB));
    expect(r.status).toBe(501);
    expect((await r.json()).code).toBe("capability_missing");
  });

  it("returns 503 with the reason when CML is not connected", async () => {
    setContext({ ...getContext(), mcp: null, mcpConfigError: "not configured" });
    expect((await topologyGet(get(`/api/labs/${LAB}/topology`), ctxFor(LAB))).status).toBe(503);
  });
});

describe("positions", () => {
  const P = `/api/labs/${LAB}/positions`;
  it("saves, returns and clears dragged positions per lab", async () => {
    expect(await (await positionsGet(get(P), ctxFor(LAB))).json()).toEqual({ positions: {} });
    expect((await positionsPut(send("PUT", P, { positions: { "n-r1": { x: 10.5, y: -20 } } }), ctxFor(LAB))).status).toBe(200);
    await positionsPut(send("PUT", P, { positions: { "n-r1": { x: 11, y: -21 }, "n-sw": { x: 5, y: 5 } } }), ctxFor(LAB));
    expect((await (await positionsGet(get(P), ctxFor(LAB))).json()).positions).toEqual({ "n-r1": { x: 11, y: -21 }, "n-sw": { x: 5, y: 5 } });
    const other = "33333333-cccc-4ccc-8ccc-333333333333";
    expect((await (await positionsGet(get(`/api/labs/${other}/positions`), ctxFor(other))).json()).positions).toEqual({});
    await positionsDelete(send("DELETE", P), ctxFor(LAB));
    expect((await (await positionsGet(get(P), ctxFor(LAB))).json()).positions).toEqual({});
  });
  it("rejects nonsense positions and bad ids", async () => {
    expect((await positionsPut(send("PUT", P, { positions: { "n-r1": { x: "a", y: 1 } } }), ctxFor(LAB))).status).toBe(400);
    expect((await positionsPut(send("PUT", P, { positions: { "n-r1": { x: 1e12, y: 1 } } }), ctxFor(LAB))).status).toBe(400);
    expect((await positionsPut(send("PUT", P, { positions: { "bad id!": { x: 1, y: 1 } } }), ctxFor(LAB))).status).toBe(400);
    expect((await positionsPut(send("PUT", P, { positions: {} }), ctxFor("../x"))).status).toBe(400);
  });
});

describe("helpers", () => {
  it("classifies CML node definitions", () => {
    const k = (d: string) => classifyNode(d);
    expect([k("iosv"), k("csr1000v"), k("cat8000v"), k("iol-xe")]).toEqual(["router", "router", "router", "router"]);
    expect([k("iosvl2"), k("iol-l2-xe"), k("unmanaged_switch")]).toEqual(["l2switch", "l2switch", "l2switch"]);
    expect([k("cat9000v"), k("nxosv9000")]).toEqual(["l3switch", "l3switch"]);
    expect([k("asav"), k("ftdv")]).toEqual(["firewall", "firewall"]);
    expect([k("alpine"), k("ubuntu"), k("desktop"), k("external_connector"), k("something-new")]).toEqual(["host", "server", "pc", "connector", "other"]);
  });
  it("maps CML link states without overclaiming", () => {
    expect(cmlLinkStatus("STARTED").status).toBe("not_inspected");
    expect(cmlLinkStatus("STOPPED").status).toBe("admin_down");
    expect(cmlLinkStatus("DEFINED_ON_CORE").status).toBe("unknown");
    expect(cmlLinkStatus("WEIRD").status).toBe("unknown");
    expect(["operational", "down", "fault"]).not.toContain(cmlLinkStatus("STARTED").status);
  });
  it("binds arguments by the tool's own schema and refuses to guess", () => {
    const tool = (props: string[], req: string[]) => ({ name: "t", description: "", inputSchema: { type: "object", properties: Object.fromEntries(props.map((p) => [p, {}])), required: req }, classification: { kind: "read" as const, reason: "" } });
    expect(bindArgs(tool(["lid", "nid"], ["lid", "nid"]), { lab: "L", node: "N" })).toEqual({ lid: "L", nid: "N" });
    expect(bindArgs(tool(["lab_id", "node_id"], ["lab_id", "node_id"]), { lab: "L", node: "N" })).toEqual({ lab_id: "L", node_id: "N" });
    expect(() => bindArgs(tool(["lid", "weird"], ["lid", "weird"]), { lab: "L" })).toThrow(/needs weird/);
    expect(() => bindArgs(tool(["foo"], []), { lab: "L" })).toThrow(/no argument that takes a lab id/);
  });
  it("resolves the three topology capabilities from tool shape", async () => {
    await getContext().mcp?.connect();
    const caps = resolveCapabilities(getContext().mcp!.tools());
    expect([caps.getLabNodes.tool, caps.getLabLinks.tool, caps.getNodeInterfaces.tool]).toEqual(["get_nodes_for_cml_lab", "get_all_links_for_lab", "get_interfaces_for_node"]);
  });
});
