import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TopoLink, TopoNode } from "@/lib/cml/topology";
import { type ExtraInput, extraFindings, isisInterfaces, parseIsisNeighbors } from "@/lib/diagnostics/checks-extra";
import type { Finding } from "@/lib/diagnostics/types";

const dir = join(__dirname, "fixtures", "captured-iolxe");
const real = (n: string, f: string) => (existsSync(join(dir, `${n}__${f}.txt`)) ? readFileSync(join(dir, `${n}__${f}.txt`), "utf8") : null);
const lon = real("London", "show_isis_neighbors");

describe.skipIf(!lon)("IS-IS output captured from a real IOL-XE lab", () => {
  it("reads every neighbour row, with the interface name normalised", () => {
    expect(parseIsisNeighbors(lon!).map((n) => [n.systemId, n.type, n.interface, n.ip, n.state])).toEqual([["Cornwall", "L2", "Ethernet0/0", "10.0.12.2", "UP"], ["Paris", "L2", "Ethernet0/1", "10.0.13.2", "UP"]]);
  });
  it("reads which interfaces run IS-IS from the real running configuration", () => {
    const cfg = real("London", "show_running_config")!;
    const names = isisInterfaces(cfg).map((i) => i.name);
    expect(names.length).toBeGreaterThan(0);
    for (const n of parseIsisNeighbors(lon!).map((x) => x.interface)) expect(names).toContain(n);
  });
  it("finds nothing wrong on a lab whose adjacencies are all up", () => {
    const names = ["London", "Cornwall", "Paris", "Amsterdam", "Hamburg"];
    for (const n of names) {
      const rows = parseIsisNeighbors(real(n, "show_isis_neighbors") ?? "");
      expect(rows.filter((r) => r.state !== "UP"), n).toEqual([]);
    }
  });
});

describe("parsing", () => {
  it("ignores headings, blank lines and anything that is not a neighbour row, and keeps a state that is not UP", () => {
    const rows = parseIsisNeighbors("\nTag null:\nSystem Id       Type Interface     IP Address      State Holdtime Circuit Id\nR2              L1L2 Gi0/1         10.0.0.2        INIT  25       01\nIS-IS not enabled\n");
    expect(rows).toEqual([expect.objectContaining({ systemId: "R2", type: "L1L2", interface: "GigabitEthernet0/1", state: "INIT" })]);
  });
  it("reads the interfaces and circuit types from a configuration, and ignores interfaces that do not run IS-IS", () => {
    const cfg = "interface Ethernet0/0\n ip address 10.0.0.1 255.255.255.0\n ip router isis\n isis circuit-type level-2-only\n!\ninterface Ethernet0/1\n ip address 10.0.1.1 255.255.255.0\n!\ninterface Loopback0\n ip router isis CORE\n!\nrouter isis\n net 49.0001.0000.0000.0001.00\n";
    expect(isisInterfaces(cfg)).toEqual([{ name: "Ethernet0/0", circuit: "level-2-only" }, { name: "Loopback0", circuit: null }]);
  });
});

describe("the checks", () => {
  const node = (id: string): TopoNode => ({ id, label: id, kind: "router", definition: "iol-xe", state: "BOOTED", bootProgress: null, x: 0, y: 0, interfaces: [], platform: "ios" }) as TopoNode;
  const link: TopoLink = { id: "l1", source: "A", target: "B", sourceInterface: "Ethernet0/0", targetInterface: "Ethernet0/0" } as TopoLink;
  const brief = (status = "up", protocol = "up") => new Map([["Ethernet0/0", { name: "Ethernet0/0", ip: "10.0.0.1", status, protocol }]]);
  const cfg = (circuit?: string, isis = true) => `interface Ethernet0/0\n ip address 10.0.0.1 255.255.255.0\n${isis ? " ip router isis\n" : ""}${circuit ? ` isis circuit-type ${circuit}\n` : ""}!\n`;
  const HEAD = "Tag null:\nSystem Id       Type Interface     IP Address      State Holdtime Circuit Id\n";
  const input = (id: string, over: Partial<ExtraInput> = {}): ExtraInput => ({ node: node(id), configText: cfg(), cfg: null, brief: brief(), stpText: null, isisText: HEAD, ...over }) as ExtraInput;
  const mk = (f: Omit<Finding, "id">): Finding => ({ id: `${f.kind}-${f.deviceId}`, ...f });
  const run = (a: ExtraInput, b: ExtraInput) => extraFindings([a, b], [link], mk, {} as never).filter((f) => f.kind.startsWith("isis"));

  it("reports a missing adjacency when both ends are up and run IS-IS but neither sees the other", () => {
    const [f] = run(input("A"), input("B"));
    expect(f).toMatchObject({ kind: "isis-adjacency-missing", severity: "critical", status: "confirmed", device: "A", interface: "Ethernet0/0", peer: { device: "B", interface: "Ethernet0/0" }, linkId: "l1" });
    expect(f.evidence).toEqual(expect.arrayContaining([expect.stringContaining("A# show isis neighbors: no neighbour on Ethernet0/0"), expect.stringContaining("B# show isis neighbors")]));
  });

  it("names the cause when the circuit types can never overlap", () => {
    const [f] = run(input("A", { configText: cfg("level-1") }), input("B", { configText: cfg("level-2-only") }));
    expect(f.probableCause).toMatch(/circuit types do not overlap: A asks for level-1, B for level-2-only/);
    expect(run(input("A", { configText: cfg("level-1") }), input("B", { configText: cfg("level-1-2") }))[0].probableCause).toMatch(/something the adjacency needs differs/);
  });

  it("says nothing when an adjacency exists at either end, when only one end runs IS-IS, or when an interface is down", () => {
    const up = `${HEAD}B               L2   Ethernet0/0   10.0.0.2        UP    27       01\n`;
    expect(run(input("A", { isisText: up }), input("B"))).toEqual([]);
    expect(run(input("A"), input("B", { configText: cfg(undefined, false) }))).toEqual([]);
    expect(run(input("A", { brief: brief("down", "down") }), input("B"))).toEqual([]);
    expect(run(input("A", { isisText: null }), input("B"))).toEqual([]); // not read: cannot say
  });

  it("reports a neighbour that is seen but not UP", () => {
    const init = `${HEAD}B               L2   Ethernet0/0   10.0.0.2        INIT  27       01\n`;
    const f = run(input("A", { isisText: init }), input("B", { isisText: init.replace("B ", "A ") }));
    expect(f.find((x) => x.kind === "isis-neighbor-not-up")).toMatchObject({ severity: "warning", status: "confirmed", device: "A", interface: "Ethernet0/0", title: "IS-IS neighbour B on Ethernet0/0 is INIT" });
    expect(f.some((x) => x.kind === "isis-adjacency-missing")).toBe(false); // it was seen, so it is not missing
  });
});
