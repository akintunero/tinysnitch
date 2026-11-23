import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TopoNode } from "@/lib/cml/topology";
import { type BgpInput, allows, bgpPolicyFindings, decidingEntry, parseBgpPolicy, parsePrefixLists, showPrefix } from "@/lib/diagnostics/checks-bgp";
import { parseIpIntBrief } from "@/lib/diagnostics/parsers";
import type { Finding } from "@/lib/diagnostics/types";

const mk = (f: Omit<Finding, "id">): Finding => ({ id: `${f.kind}-${f.deviceId}-${f.title.length}`, ...f });
const P = (s: string) => { const [a, l] = s.split("/"); return { net: a.split(".").reduce((n, o) => n * 256 + Number(o), 0) >>> 0, len: Number(l) }; };

describe("evaluating a prefix-list", () => {
  const lists = parsePrefixLists("ip prefix-list FROM-AMS seq 5 deny 10.104.8.0/21 ge 24 le 24\nip prefix-list FROM-AMS seq 10 permit 0.0.0.0/0 le 32\nip prefix-list EXACT seq 5 permit 10.0.0.0/8\nip prefix-list LATE seq 20 permit 10.0.0.0/8 le 24\nip prefix-list LATE seq 10 deny 10.1.0.0/16 le 24\n");
  it("applies ge and le, and the first matching entry decides", () => {
    const f = lists.get("FROM-AMS")!;
    for (const p of ["10.104.0.0/24", "10.104.7.0/24", "10.104.16.0/24", "10.104.255.1/32", "10.105.8.0/24"]) expect(allows(f, P(p)), p).toBe(true);
    for (const p of ["10.104.8.0/24", "10.104.12.0/24", "10.104.15.0/24"]) expect(allows(f, P(p)), p).toBe(false);
    expect(allows(f, P("10.104.8.0/21"))).toBe(true); // a /21 is not a /24, so the deny entry does not match it
    expect(decidingEntry(f, P("10.104.9.0/24"))!.raw).toBe("ip prefix-list FROM-AMS seq 5 deny 10.104.8.0/21 ge 24 le 24");
  });
  it("treats a prefix with no ge or le as an exact match, and no match as a deny", () => {
    const e = lists.get("EXACT")!;
    expect(allows(e, P("10.0.0.0/8"))).toBe(true);
    expect(allows(e, P("10.1.0.0/16"))).toBe(false);
    expect(decidingEntry(e, P("192.168.0.0/24"))).toBeNull();
  });
  it("orders entries by sequence number, not by where they are written", () => {
    const l = lists.get("LATE")!;
    expect(allows(l, P("10.1.5.0/24"))).toBe(false);
    expect(allows(l, P("10.2.5.0/24"))).toBe(true);
  });
  it("reads a configuration's BGP policy", () => {
    const p = parseBgpPolicy("router bgp 65100\n bgp log-neighbor-changes\n neighbor 10.0.24.2 remote-as 65200\n address-family ipv4\n  network 10.1.0.0 mask 255.255.255.0\n  network 10.1.255.1 mask 255.255.255.255\n  neighbor 10.0.24.2 activate\n  neighbor 10.0.24.2 prefix-list FROM-AMS in\n  neighbor 10.0.24.2 route-map LP in\n exit-address-family\n!\nroute-map LP permit 10\n match ip address prefix-list PL-X\n set local-preference 200\n");
    expect(p.localAs).toBe("65100");
    expect(p.networks.map(showPrefix)).toEqual(["10.1.0.0/24", "10.1.255.1/32"]);
    expect(p.neighbors.get("10.0.24.2")).toMatchObject({ remoteAs: "65200", prefixListIn: "FROM-AMS", routeMapIn: "LP" });
    expect([...p.routeMaps]).toEqual(["LP"]);
    expect(p.routeMapPrefixLists.get("LP")).toEqual(["PL-X"]);
  });
});

const dir = join(__dirname, "fixtures", "captured-iolxe");
const NAMES = ["London", "Cornwall", "Paris", "Amsterdam", "Hamburg"];
const read = (n: string, f: string) => (existsSync(join(dir, `${n}__${f}.txt`)) ? readFileSync(join(dir, `${n}__${f}.txt`), "utf8") : null);
const have = NAMES.every((n) => read(n, "show_running_config") && read(n, "show_ip_bgp_summary") && read(n, "show_ip_interface_brief"));
const node = (label: string): TopoNode => ({ id: label, label, kind: "router", definition: "iol-xe", state: "BOOTED", bootProgress: null, x: 0, y: 0, interfaces: [], platform: "ios" }) as TopoNode;
const realInputs = (): BgpInput[] => NAMES.map((n) => ({ node: node(n), configText: read(n, "show_running_config"), bgpText: read(n, "show_ip_bgp_summary"), brief: new Map(parseIpIntBrief(read(n, "show_ip_interface_brief")!).map((r) => [r.name, r])) }));

describe.skipIf(!have)("the real five-router lab", () => {
  const found = have ? bgpPolicyFindings(realInputs(), mk) : [];
  const by = (kind: string) => found.filter((f) => f.kind === kind);

  it("finds the filter on Cornwall that removes eight of Amsterdam's prefixes, and shows that the count agrees", () => {
    const [f] = by("route-filter-blocks-prefixes");
    expect(by("route-filter-blocks-prefixes")).toHaveLength(1);
    expect(f).toMatchObject({ device: "Cornwall", severity: "warning", status: "confirmed", peer: { device: "Amsterdam" }, title: "Inbound prefix-list FROM-AMS on Cornwall blocks 8 of the 42 prefixes AS 65200 originates" });
    expect(f.description).toContain("10.104.8.0/24 … 10.104.15.0/24");
    expect(f.description).toContain("exactly why Cornwall receives 34 prefixes instead of 42");
    expect(f.evidence).toEqual(expect.arrayContaining([expect.stringContaining("neighbor 10.0.24.2 prefix-list FROM-AMS in"), expect.stringContaining("deny 10.104.8.0/21 ge 24 le 24"), expect.stringMatching(/Cornwall# show ip bgp summary: 10\.0\.24\.2 .* 34$/)]));
  });

  it("notes the prefix-list on Paris that is named like a block list but only permits", () => {
    const f = by("route-filter-name-misleading");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ device: "Paris", severity: "info", title: "Prefix-list PL-Amsterdam-BLOCK is named like a block list but only permits" });
    expect(f[0].description).toContain("route-map LP-PRIMARY");
  });

  it("raises no shortfall and no undefined-filter finding on a lab where the counts add up", () => {
    expect(by("bgp-prefix-shortfall")).toEqual([]);
    expect(by("route-filter-undefined")).toEqual([]);
    expect(found.map((f) => f.device).sort()).toEqual(["Cornwall", "Paris"]);
  });
});

describe("the checks on written-out configurations", () => {
  const cfg = (as: string, nets: string[], neighbors: string[], extra = "") => `router bgp ${as}\n address-family ipv4\n${nets.map((n) => `  network ${n} mask 255.255.255.0\n`).join("")}${neighbors.map((n) => `  ${n}\n`).join("")} exit-address-family\n${extra}`;
  const brief = (ip: string) => new Map([["Ethernet0/0", { name: "Ethernet0/0", ip, status: "up", protocol: "up" }]]);
  const summary = (rows: [string, string, string][]) => `BGP router identifier 1.1.1.1, local AS number 65100\nNeighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n${rows.map(([n, as, c]) => `${n.padEnd(16)}4 ${as.padStart(12)}      10      10        1    0    0 00:10:00 ${c}`).join("\n")}\n`;
  const pair = (aCfg: string, aSum: string, bNets = ["10.2.0.0", "10.2.1.0", "10.2.2.0"]): BgpInput[] => [
    { node: node("A"), configText: aCfg, bgpText: aSum, brief: brief("10.0.0.1") },
    { node: node("B"), configText: cfg("65200", bNets, ["neighbor 10.0.0.1 remote-as 65100"]), bgpText: summary([["10.0.0.1", "65100", "1"]]), brief: brief("10.0.0.2") },
  ];
  const nb = (extra: string[]) => cfg("65100", ["10.1.0.0"], ["neighbor 10.0.0.2 remote-as 65200", ...extra]);

  it("reports an undefined prefix-list or route-map on a neighbor line", () => {
    const f = bgpPolicyFindings(pair(nb(["neighbor 10.0.0.2 prefix-list NOPE in", "neighbor 10.0.0.2 route-map GONE out"]), summary([["10.0.0.2", "65200", "3"]])), mk).filter((x) => x.kind === "route-filter-undefined");
    expect(f.map((x) => x.title)).toEqual(["Prefix-list NOPE is used on neighbor 10.0.0.2 but is not defined", "Route-map GONE is used on neighbor 10.0.0.2 but is not defined"]);
    expect(f[0].status).toBe("confirmed");
  });

  it("reports a shortfall that nothing in the configuration explains, as suspected only", () => {
    const f = bgpPolicyFindings(pair(nb([]), summary([["10.0.0.2", "65200", "1"]])), mk);
    expect(f.map((x) => x.kind)).toEqual(["bgp-prefix-shortfall"]);
    expect(f[0]).toMatchObject({ status: "suspected", title: "A receives 1 prefixes from 10.0.0.2, 2 fewer than expected" });
  });

  it("does not call the filter the cause unless its denies are real, and stays quiet when the counts agree", () => {
    const withFilter = nb(["neighbor 10.0.0.2 prefix-list F in"]) + "ip prefix-list F seq 5 deny 10.2.2.0/24\nip prefix-list F seq 10 permit 0.0.0.0/0 le 32\n";
    const exact = bgpPolicyFindings(pair(withFilter, summary([["10.0.0.2", "65200", "2"]])), mk);
    expect(exact.map((x) => x.kind)).toEqual(["route-filter-blocks-prefixes"]);
    expect(exact[0].description).toContain("exactly why A receives 2 prefixes instead of 3");
    // the filter blocks one prefix, but the session delivers even fewer: the filter explains part, not all
    const worse = bgpPolicyFindings(pair(withFilter, summary([["10.0.0.2", "65200", "0"]])), mk).map((x) => x.kind).sort();
    expect(worse).toEqual(["bgp-prefix-shortfall", "route-filter-blocks-prefixes"]);
    // all three arrive although the filter says one is denied: the filter is not what the device is applying yet
    expect(bgpPolicyFindings(pair(withFilter, summary([["10.0.0.2", "65200", "3"]])), mk).find((x) => x.kind === "route-filter-blocks-prefixes")!.description).not.toContain("exactly why");
  });

  it("ignores a filter that blocks nothing, a filter that blocks everything, iBGP and a session that is not established", () => {
    const permitAll = nb(["neighbor 10.0.0.2 prefix-list ALL in"]) + "ip prefix-list ALL seq 5 permit 0.0.0.0/0 le 32\n";
    const denyAll = nb(["neighbor 10.0.0.2 prefix-list NONE in"]) + "ip prefix-list NONE seq 5 deny 0.0.0.0/0 le 32\n";
    const kinds = (c: string, s: string) => bgpPolicyFindings(pair(c, s), mk).map((x) => x.kind);
    expect(kinds(permitAll, summary([["10.0.0.2", "65200", "3"]]))).toEqual([]);
    expect(kinds(denyAll, summary([["10.0.0.2", "65200", "0"]]))).toEqual([]); // a deliberate "accept nothing", reported by no check
    expect(kinds(nb([]), summary([["10.0.0.2", "65200", "Idle"]]))).toEqual([]);
    const ibgp = cfg("65100", ["10.1.0.0"], ["neighbor 10.0.0.2 remote-as 65100"]);
    expect(kinds(ibgp, summary([["10.0.0.2", "65100", "1"]]))).toEqual([]);
  });

  it("does not call a list named like a block list misleading when it does deny, or when nothing uses it", () => {
    const denies = "ip prefix-list BLOCK-X seq 5 deny 10.9.0.0/16\nip prefix-list BLOCK-X seq 10 permit 0.0.0.0/0 le 32\nroute-map R permit 10\n match ip address prefix-list BLOCK-X\n";
    const unused = "ip prefix-list BLOCK-Y seq 5 permit 10.9.0.0/16\n";
    expect(bgpPolicyFindings(pair(nb([]) + denies + unused, summary([["10.0.0.2", "65200", "3"]])), mk).filter((x) => x.kind === "route-filter-name-misleading")).toEqual([]);
  });
});
