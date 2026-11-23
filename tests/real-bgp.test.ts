import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Topology } from "@/lib/cml/topology";
import { analyse } from "@/lib/diagnostics/checks";
import { CMD } from "@/lib/diagnostics/commands";
import { parseBgpSummary, parseIpIntBrief } from "@/lib/diagnostics/parsers";
import type { DeviceSnapshot } from "@/lib/diagnostics/types";

/**
 * Output captured from a real running CML lab of five IOL-XE routers (IS-IS plus iBGP and eBGP) that was built with faults
 * on purpose. The one these routers show: London's neighbour 10.0.15.2 is configured as AS 65201, but that address belongs
 * to Hamburg, which runs AS 65200, so the session sits in Idle.
 */
const dir = join(__dirname, "fixtures", "captured-iolxe");
const NAMES = ["London", "Cornwall", "Paris", "Amsterdam", "Hamburg"];
const have = NAMES.filter((n) => existsSync(join(dir, `${n}__show_ip_bgp_summary.txt`)) && existsSync(join(dir, `${n}__show_ip_interface_brief.txt`)) && existsSync(join(dir, `${n}__show_running_config.txt`)));
const read = (n: string, cmd: string) => readFileSync(join(dir, `${n}__${cmd}.txt`), "utf8");
const ready = have.length === NAMES.length;

describe.skipIf(!existsSync(join(dir, "London__show_ip_bgp_summary.txt")))("BGP output captured from a real IOL-XE lab", () => {
  it("parses every neighbour line, including the Idle one with no prefix count", () => {
    const peers = parseBgpSummary(read("London", "show_ip_bgp_summary"));
    expect(peers.map((p) => [p.neighbor, p.as, p.state, p.prefixes])).toEqual([
      ["10.0.15.2", "65201", "Idle", null],
      ["10.255.0.2", "65100", "Established", 43],
      ["10.255.0.3", "65100", "Established", 41],
    ]);
    expect(parseBgpSummary(read("Cornwall", "show_ip_bgp_summary")).every((p) => p.state === "Established")).toBe(true);
    expect(parseBgpSummary(read("Amsterdam", "show_ip_bgp_summary")).map((p) => p.prefixes)).toEqual([63, 63, 21]);
  });

  it("reads the real interface table, loopbacks included", () => {
    const rows = parseIpIntBrief(read("London", "show_ip_interface_brief"));
    expect(rows.map((r) => [r.name, r.ip, r.status])).toEqual(expect.arrayContaining([["Ethernet0/2", "10.0.15.1", "up"], ["Loopback0", "10.255.0.1", "up"], ["Ethernet0/3", null, "administratively down"]]));
  });
});

describe.skipIf(!ready)("the checks, run on the whole real lab", () => {
  const nodes = NAMES.map((n) => ({ id: n, label: n, kind: "router" as const, definition: "iol-xe", state: "BOOTED", bootProgress: null, x: 0, y: 0, interfaces: [] }));
  const topology = { lab: { id: "netclan", title: "netclan-lab", state: "STARTED" }, nodes, links: [], fetchedAt: "", warnings: [] } as Topology;
  const snaps = new Map<string, DeviceSnapshot>(NAMES.map((n) => [n, { nodeId: n, label: n, kind: "router", commands: {
    [CMD.config]: { ok: true, text: read(n, "show_running_config") },
    [CMD.brief]: { ok: true, text: read(n, "show_ip_interface_brief") },
    [CMD.bgp]: { ok: true, text: read(n, "show_ip_bgp_summary") },
  } }]));
  const result = analyse(topology, snaps, []);

  it("finds the cause of London's down session, not only the symptom", () => {
    const f = result.findings.find((x) => x.kind === "bgp-as-mismatch");
    expect(f).toBeDefined();
    expect(f).toMatchObject({ device: "London", severity: "critical", status: "confirmed", title: "BGP peer 10.0.15.2 is set to AS 65201, but Hamburg runs AS 65200" });
    expect(f!.evidence).toEqual([
      expect.stringContaining("London# show ip bgp summary: 10.0.15.2"),
      "London# show running-config: neighbor 10.0.15.2 remote-as 65201",
      expect.stringMatching(/^Hamburg# show ip bgp summary: BGP router identifier .*local AS number 65200$/),
    ]);
    expect(f!.recommendedAction).toContain('"neighbor 10.0.15.2 remote-as 65200" on London');
    expect(f!.fix).toEqual({ summary: "Set neighbor 10.0.15.2 to remote-as 65200 on London", note: expect.stringContaining("If Hamburg is the one with the wrong AS"), commands: ["router bgp 65100", "neighbor 10.0.15.2 remote-as 65200"] });
  });

  it("also finds the route-filter findings when the whole engine runs, not only when the check is called directly", () => {
    const kinds = result.findings.map((x) => `${x.device}:${x.kind}`);
    expect(kinds).toContain("Cornwall:route-filter-blocks-prefixes");
    expect(kinds).toContain("Paris:route-filter-name-misleading");
  });

  it("raises it once, and does not blame the healthy sessions", () => {
    expect(result.findings.filter((x) => x.kind === "bgp-as-mismatch")).toHaveLength(1);
    expect(result.findings.filter((x) => x.kind === "bgp-peer-down").every((x) => ["London", "Hamburg"].includes(x.device))).toBe(true);
  });
});
