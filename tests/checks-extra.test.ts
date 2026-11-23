import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Topology } from "@/lib/cml/topology";
import { analyse } from "@/lib/diagnostics/checks";
import { type ExtraInput, baseline, extraFindings, parseAce, parseAcls, parseStaticRoutes, parseStp, shadows } from "@/lib/diagnostics/checks-extra";
import { CMD } from "@/lib/diagnostics/commands";
import { parseIpIntBrief, parseRunningConfig } from "@/lib/diagnostics/parsers";
import type { DeviceSnapshot, Finding } from "@/lib/diagnostics/types";
import { openDatabase } from "@/lib/database/db";
import { saveSettings } from "@/lib/database/repo";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { startStatefulDevice } from "./helpers/fake-device";

const mk = (f: Omit<Finding, "id">): Finding => ({ id: createHash("sha1").update(`${f.kind}|${f.deviceId}|${f.interface ?? ""}|${f.title}`).digest("hex").slice(0, 12), ...f });
const node = (id: string, label = id) => ({ id, label, kind: "router" as const, definition: "iosv", state: "BOOTED", bootProgress: null, x: 0, y: 0, interfaces: [] });
const input = (config: string | null, over: Partial<ExtraInput> = {}, id = "r1"): ExtraInput => ({
  node: node(id), configText: config, cfg: config ? parseRunningConfig(config) : null, brief: null, stpText: null, ...over,
});
const briefOf = (rows: string) => new Map(parseIpIntBrief(`Interface IP-Address OK? Method Status Protocol\n${rows}`).map((r) => [r.name, r]));
const kinds = (fs: Finding[]) => fs.map((f) => f.kind).sort();

const dir = join(__dirname, "fixtures", "captured");
const haveReal = existsSync(join(dir, "London__show_running_config.txt"));

describe.skipIf(!haveReal)("baseline and spanning tree on output captured from real IOSv / IOSvL2", () => {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  it("finds exactly what is true of London's real configuration", () => {
    // London has no 'ip ssh version 2', no NTP, no remote syslog and 'no aaa new-model'; its VTY lines are 'transport input none'
    // and 'ip http server' is off, so none of the Telnet or HTTP findings may appear.
    expect(baseline(read("London__show_running_config.txt")).map((h) => h.kind)).toEqual(["hygiene-ssh-v2", "hygiene-ntp", "hygiene-logging", "hygiene-aaa"]);
    expect(baseline(read("Paris__show_running_config.txt")).map((h) => h.kind)).toEqual(["hygiene-ssh-v2", "hygiene-ntp", "hygiene-logging", "hygiene-aaa"]);
  });
  it("reads the real switch's spanning tree: it is the root, every port forwarding", () => {
    const v = parseStp(read("London-ME-01__show_spanning_tree.txt"));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ vlan: "VLAN0001", rootAddr: "5254.002f.466b", isRoot: true, bridgeAddr: "5254.002f.466b" });
    expect(v[0].ports.map((p) => `${p.name}:${p.role}:${p.state}`)).toEqual(["GigabitEthernet0/0:Desg:FWD", "GigabitEthernet0/1:Desg:FWD", "GigabitEthernet0/2:Desg:FWD", "GigabitEthernet0/3:Desg:FWD"]);
    expect(v[0].ports.every((p) => p.inconsistent === null)).toBe(true);
  });
});

describe("security baseline", () => {
  const GOOD = "ip ssh version 2\nntp server 10.0.0.9\nlogging host 10.0.0.8\naaa new-model\nno ip http server\nline vty 0 4\n login local\n transport input ssh\n";
  it("reports nothing for a configuration that is fine", () => expect(baseline(GOOD)).toEqual([]));

  it("flags weak settings, quoting the line, and never repeats a password", () => {
    const bad = `${GOOD.replace("ip ssh version 2\n", "").replace("transport input ssh", "transport input telnet ssh")}enable password 7 0822455D0A16\nusername bob privilege 15 password 0 hunter2\nsnmp-server community public RO\nip http server\n`;
    const hits = baseline(bad.replace("no ip http server\n", ""));
    expect(hits.map((h) => h.kind).sort()).toEqual(["hygiene-enable-password", "hygiene-http-server", "hygiene-snmp-default", "hygiene-ssh-v2", "hygiene-telnet", "hygiene-username-password"]);
    const text = JSON.stringify(hits);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("0822455D0A16");
    expect(hits.find((h) => h.kind === "hygiene-snmp-default")?.evidence).toEqual(["snmp-server community public RO"]);
  });

  it("calls a VTY block with no transport line a possible Telnet, not a confirmed one", () => {
    const h = baseline("ip ssh version 2\nline vty 0 4\n login\n");
    expect(h.find((x) => x.kind === "hygiene-telnet-default")).toMatchObject({ severity: "info" });
    expect(h.some((x) => x.kind === "hygiene-telnet")).toBe(false);
  });

  it("is only included when asked for", () => {
    const i = [input("hostname r1\n")];
    expect(extraFindings(i, [], mk, { compliance: false }).filter((f) => f.kind.startsWith("hygiene-"))).toEqual([]);
    const on = extraFindings(i, [], mk, { compliance: true });
    expect(kinds(on)).toEqual(["hygiene-aaa", "hygiene-logging", "hygiene-ntp", "hygiene-ssh-v2"]);
    expect(on.every((f) => f.status === "confirmed" && f.evidence[0].startsWith("r1# show running-config:"))).toBe(true);
  });
});

describe("spanning tree", () => {
  const stp = (root: string, extra = "") => `
VLAN0010
  Spanning tree enabled protocol ieee
  Root ID    Priority    4106
             Address     ${root}
             Cost        4

  Bridge ID  Priority    32778
             Address     5254.0000.0001

Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- --------------------------------
Gi0/0               Root FWD 4         128.1    P2p
${extra}`;
  it("flags a port the switch itself put in an inconsistent state", () => {
    const f = extraFindings([input("hostname s1\n", { stpText: stp("5254.00aa.0001", "Gi0/1               Desg BKN*4         128.2    P2p *ROOT_Inc\n") })], [], mk, { compliance: false });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "stp-inconsistent", status: "confirmed", interface: "GigabitEthernet0/1" });
    expect(f[0].evidence[0]).toContain("BKN*");
  });
  it("calls out linked switches that disagree on the root, as suspected, and not ones that agree", () => {
    const link = { id: "l1", source: "s1", target: "s2", sourceInterface: "Gi0/0", targetInterface: "Gi0/0", cmlState: "STARTED", status: "not_inspected" as const, statusText: "" };
    const split = extraFindings([input(null, { stpText: stp("5254.00aa.0001") }, "s1"), input(null, { stpText: stp("5254.00bb.0002") }, "s2")], [link], mk, { compliance: false });
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ kind: "stp-root-disagreement", status: "suspected" });
    expect(split[0].verification).toMatch(/show interfaces trunk/);
    expect(extraFindings([input(null, { stpText: stp("5254.00aa.0001") }, "s1"), input(null, { stpText: stp("5254.00aa.0001") }, "s2")], [link], mk, { compliance: false })).toEqual([]);
  });
  it("concludes nothing from a router with no spanning-tree output", () => {
    expect(extraFindings([input("hostname r1\n", { stpText: "" })], [], mk, { compliance: false })).toEqual([]);
  });
});

describe("static routes", () => {
  const cfg = (route: string) => `hostname r1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n!\n${route}\n`;
  const up = briefOf("GigabitEthernet0/0 10.0.0.1 YES manual up up");
  const down = briefOf("GigabitEthernet0/0 10.0.0.1 YES manual administratively down down");
  const run = (route: string, brief = up) => extraFindings([input(cfg(route), { brief })], [], mk, { compliance: false });

  it("parses next hops given as an address, an interface, or both, and skips VRF routes", () => {
    const r = parseStaticRoutes("ip route 1.1.1.0 255.255.255.0 10.0.0.2\nip route 2.2.2.0 255.255.255.0 GigabitEthernet0/0\nip route 3.3.3.0 255.255.255.0 GigabitEthernet0/0 10.0.0.9 name x\nip route vrf RED 4.4.4.0 255.255.255.0 10.0.0.3\n");
    expect(r.map((x) => [x.prefix, x.nextHop, x.iface])).toEqual([["1.1.1.0", "10.0.0.2", null], ["2.2.2.0", null, "GigabitEthernet0/0"], ["3.3.3.0", "10.0.0.9", "GigabitEthernet0/0"]]);
  });
  it("is quiet when the next hop is on a live connected subnet", () => expect(run("ip route 192.168.5.0 255.255.255.0 10.0.0.2")).toEqual([]));
  it("suspects a next hop outside every connected subnet (it could be recursive)", () => {
    const f = run("ip route 172.16.0.0 255.255.0.0 10.9.9.9");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "static-route-nexthop", status: "suspected" });
    expect(f[0].verification).toMatch(/show ip route 10\.9\.9\.9/);
  });
  it("confirms a next hop behind an interface that is down", () => {
    const f = run("ip route 192.168.5.0 255.255.255.0 10.0.0.2", down);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "static-route-nexthop-down", status: "confirmed", interface: "GigabitEthernet0/0" });
    expect(f[0].evidence.join("\n")).toContain("administratively down/down");
  });
  it("does not conclude 'down' when it never read the interface state", () => {
    expect(run("ip route 192.168.5.0 255.255.255.0 10.0.0.2", new Map())).toEqual([]);
  });
});

describe("access lists", () => {
  const find = (config: string) => extraFindings([input(config)], [], mk, { compliance: false });

  it("parses entries, address forms and port specs", () => {
    const a = parseAce("10 permit tcp 10.0.0.0 0.0.0.255 eq 1024 host 192.0.2.5 range 80 90 log", "extended")!;
    expect(a).toMatchObject({ seq: 10, action: "permit", proto: "tcp", srcPort: { op: "eq", values: ["1024"] }, dstPort: { op: "range", values: ["80", "90"] }, extra: "" });
    expect(parseAce("deny ip any any", "extended")).toMatchObject({ action: "deny", proto: "ip" });
    expect(parseAce("permit 10.1.1.1", "standard")).toMatchObject({ proto: "ip", src: { wild: 0 } });
    expect(parseAce("remark nope", "extended")).toBeNull();
  });

  it("finds an entry an earlier, broader one already decides, and says whether they disagree", () => {
    const f = find("ip access-list extended EDGE\n 10 permit ip any any\n 20 deny tcp any host 10.0.0.5 eq 22\n 30 permit ip any any\n!\n");
    expect(f.map((x) => [x.kind, x.severity])).toEqual(expect.arrayContaining([["acl-conflict", "warning"], ["acl-redundant", "info"]]));
    expect(f.find((x) => x.kind === "acl-conflict")?.description).toMatch(/can never match/);
    expect(f.find((x) => x.kind === "acl-conflict")?.evidence).toHaveLength(2);
  });
  it("is quiet when a specific entry comes before a general one", () => {
    expect(find("ip access-list extended OK\n 10 permit tcp any host 10.0.0.5 eq 22\n 20 deny ip any any\n!\n")).toEqual([]);
    expect(find("ip access-list extended OK\n 10 permit tcp any any eq 80\n 20 deny tcp any any eq 443\n!\n")).toEqual([]);
  });
  it("does not claim a shadow when the earlier entry has conditions the later one lacks", () => {
    expect(find("ip access-list extended EST\n 10 permit tcp any any established\n 20 deny tcp any any\n!\n")).toEqual([]);
  });
  it("handles numbered ACLs and subnet containment", () => {
    const f = find("access-list 101 permit tcp 10.0.0.0 0.0.0.255 any eq 80\naccess-list 101 deny tcp host 10.0.0.7 any eq 80\naccess-list 10 permit 10.0.0.0 0.0.0.255\naccess-list 10 deny host 10.0.0.5\n");
    expect(f.filter((x) => x.kind === "acl-conflict")).toHaveLength(2);
    expect(shadows(parseAce("permit ip 10.0.0.0 0.0.255.255 any", "extended")!, parseAce("deny ip 10.0.1.0 0.0.0.255 any", "extended")!)).toBe(true);
    expect(shadows(parseAce("permit ip 10.0.1.0 0.0.0.255 any", "extended")!, parseAce("deny ip 10.0.0.0 0.0.255.255 any", "extended")!)).toBe(false);
  });
  it("confirms an ACL that is applied but not defined", () => {
    const f = find("interface GigabitEthernet0/1\n ip address 10.0.1.1 255.255.255.0\n ip access-group MISSING in\n!\nip access-list extended OTHER\n 10 permit ip any any\n!\n");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "acl-undefined", status: "confirmed", interface: "GigabitEthernet0/1" });
    expect(f[0].description).toMatch(/permits all traffic/);
  });
  it("does not flag an applied ACL that exists", () => {
    expect(find("interface GigabitEthernet0/1\n ip access-group EDGE in\n!\nip access-list extended EDGE\n 10 permit ip any any\n!\n")).toEqual([]);
  });
  it("keeps one finding per entry stable between runs, and caps a flood", () => {
    const many = `ip access-list extended BIG\n 10 permit ip any any\n${Array.from({ length: 25 }, (_, i) => ` ${20 + i * 10} deny tcp any any eq ${1000 + i}`).join("\n")}\n!\n`;
    const a = find(many), b = find(many);
    expect(a).toHaveLength(10);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(new Set(a.map((x) => x.id)).size).toBe(10);
  });
});

describe("wired into the check engine", () => {
  const topology = { lab: { id: "t", title: "T", state: "STARTED" }, nodes: [node("r1")], links: [], fetchedAt: "", warnings: [] } as Topology;
  const snaps = (config: string): Map<string, DeviceSnapshot> => new Map([["r1", { nodeId: "r1", label: "r1", kind: "router", commands: {
    [CMD.config]: { ok: true, text: config }, [CMD.brief]: { ok: true, text: "Interface IP-Address OK? Method Status Protocol\nGigabitEthernet0/0 10.0.0.1 YES manual up up" },
  } }]]);
  const cfg = "hostname r1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n ip access-group GONE in\n!\nip route 172.16.0.0 255.255.0.0 10.9.9.9\n";

  it("adds the ACL and route findings, and the baseline only when asked", () => {
    const off = analyse(topology, snaps(cfg), []);
    expect(kinds(off.findings)).toEqual(["acl-undefined", "static-route-nexthop"]);
    const on = analyse(topology, snaps(cfg), [], { compliance: true });
    expect(on.findings.filter((f) => f.kind.startsWith("hygiene-")).length).toBeGreaterThan(0);
  });
  it("gives each finding a stable id that survives a second run", () => {
    expect(analyse(topology, snaps(cfg), []).findings.map((f) => f.id)).toEqual(analyse(topology, snaps(cfg), []).findings.map((f) => f.id));
  });
  it("does nothing for a device whose commands failed", () => {
    const failed = new Map<string, DeviceSnapshot>([["r1", { nodeId: "r1", label: "r1", kind: "router", commands: { [CMD.config]: { ok: false, text: "timeout" }, [CMD.brief]: { ok: false, text: "timeout" } } }]]);
    expect(analyse(topology, failed, [], { compliance: true }).findings).toEqual([]);
  });
});

describe("the baseline setting, end to end over SSH", () => {
  let dev: { close: () => void } | null = null;
  afterEach(() => { dev?.close(); dev = null; setProviders(null); setContext(undefined); });

  async function run(env: "lab" | "production", complianceChecks: "off" | "production" | "all") {
    const d = await startStatefulDevice({ host: "R1", config: "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n" });
    dev = d;
    process.env.TS_TEST_PW = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-cmp-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: ${env}\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${d.port}, platform: ios, kind: router }\n`);
    const db = openDatabase(":memory:");
    saveSettings(db, { complianceChecks });
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, llm: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
    return (await runDiagnostics("static:s", { pings: false })).findings.filter((f) => f.kind.startsWith("hygiene-"));
  }

  it("applies the baseline to a production network by default, and skips a lab", async () => {
    expect((await run("production", "production")).length).toBeGreaterThan(0);
    dev?.close();
    expect(await run("lab", "production")).toEqual([]);
  });
  it("can be turned on for labs, or off for production", async () => {
    expect((await run("lab", "all")).length).toBeGreaterThan(0);
    dev?.close();
    expect(await run("production", "off")).toEqual([]);
  });
});
