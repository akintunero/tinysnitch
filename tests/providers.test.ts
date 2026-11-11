import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessLine, blockedLines } from "@/lib/core/safety";
import { openDatabase } from "@/lib/database/db";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { parseEosBgpSummary, parseEosConfig, parseEosIpIntBrief, parseEosOspfNeighbors, parseEosPing } from "@/lib/diagnostics/parsers-eos";
import { driverFor, keysFor } from "@/lib/diagnostics/platforms";
import { InventoryError, parseInventory } from "@/lib/providers/inventory-file";
import { NetboxProvider } from "@/lib/providers/netbox";
import { providerFor, setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { crawl, parseCdpDetail, parseLldpDetail } from "@/lib/providers/discovery";
import { setContext } from "@/lib/server/context";
import { type FakeDevice, brief, startFakeDevice } from "./helpers/fake-device";

const INV = `
credentials:
  lab: { username: admin, password: env:TS_TEST_PW }
sites:
  - id: hq
    title: Head office
    environment: production
    credential: lab
    devices:
      - { name: R1, address: 127.0.0.1, platform: ios }
      - { name: R2, address: 127.0.0.1, platform: ios }
    links:
      - { a: R1, aInterface: Gi0/0, b: R2, bInterface: Gi0/0 }
`;

describe("inventory file", () => {
  it("accepts a valid file and fills in defaults", () => {
    const inv = parseInventory(INV);
    expect(inv.sites[0].devices).toHaveLength(2);
    expect(inv.discovery).toEqual([]);
  });

  it("refuses a literal password: secrets are references, never written in the file", () => {
    expect(() => parseInventory(INV.replace("env:TS_TEST_PW", "hunter2"))).toThrow(/env:NAME or file:/);
  });

  it("names the problem and where it is", () => {
    expect(() => parseInventory(INV.replace("credential: lab", "credential: nope"))).toThrow(/credential "nope", which is not defined/);
    expect(() => parseInventory(INV.replace("b: R2", "b: R9"))).toThrow(/"R9"/);
    expect(() => parseInventory(INV.replace("platform: ios }\n      - { name: R2", "platform: vms }\n      - { name: R2"))).toThrow(InventoryError);
    expect(() => parseInventory("sites: []\n")).toThrow(/at least one site or discovery/);
    expect(() => parseInventory("{{{")).toThrow(InventoryError);
  });

  it("rejects unknown keys instead of ignoring them", () => {
    expect(() => parseInventory(INV.replace("environment: production", "environment: production\n    pasword: x"))).toThrow(InventoryError);
  });
});

describe("configuration safety", () => {
  it("blocks commands that destroy state or are not configuration", () => {
    for (const l of ["reload", "write erase", "erase startup-config", "copy tftp: running-config", "crypto key zeroize rsa", "debug all", "clear ip ospf process", "show version", "do reload", "end", "a; b", "x > y", ""]) {
      expect(assessLine(l).risk, l).toBe("blocked");
    }
  });
  it("marks lockout-capable commands high risk, and ordinary ones normal", () => {
    for (const l of ["username bob secret x", "enable secret x", "line vty 0 4", "aaa new-model", "no router ospf 1", "no interface Loopback0", "no ip routing", "ip route 0.0.0.0 0.0.0.0 10.0.0.1"]) expect(assessLine(l).risk, l).toBe("high");
    for (const l of ["interface GigabitEthernet0/1", "description uplink", "ip address 10.0.0.1 255.255.255.0", "no shutdown", "router ospf 1", "network 10.0.0.0 0.0.0.255 area 0"]) expect(assessLine(l).risk, l).toBe("normal");
    expect(blockedLines(["description x", "reload"]).map((a) => a.line)).toEqual(["reload"]);
  });
});

describe("EOS parsers (documented sample output, not a real device)", () => {
  it("reads show ip interface brief", () => {
    const rows = parseEosIpIntBrief(`                                                                    Address
Interface         IP Address         Status       Protocol           MTU Owner
----------------- ------------------ ------------ -------------- ---------- -------
Ethernet1         10.0.0.0/31        up           up                 1500
Ethernet2         unassigned         admin down   down               1500
Loopback0         1.1.1.1/32         up           up                65535
Management1       192.168.1.5/24     down         lowerLayerDown     1500`);
    expect(rows.map((r) => [r.name, r.ip, r.status, r.protocol])).toEqual([
      ["Ethernet1", "10.0.0.0", "up", "up"], ["Ethernet2", null, "administratively down", "down"], ["Loopback0", "1.1.1.1", "up", "up"], ["Management1", "192.168.1.5", "down", "down"],
    ]);
  });
  it("reads OSPF neighbours and BGP peers", () => {
    expect(parseEosOspfNeighbors("Neighbor ID     Instance VRF      Pri State                  Dead Time   Address         Interface\n10.0.0.2        1        default  1   FULL/DR                00:00:34    10.0.0.1        Ethernet1")).toEqual([
      { neighborId: "10.0.0.2", state: "FULL", role: "DR", address: "10.0.0.1", interface: "Ethernet1" },
    ]);
    const bgp = parseEosBgpSummary("BGP summary information for VRF default\nRouter identifier 1.1.1.1, local AS number 65001\n  Neighbor V AS           MsgRcvd   MsgSent  InQ OutQ  Up/Down State   PfxRcd PfxAcc\n  10.0.0.1 4 65002              5         6    0    0 00:00:12 Estab   2      2\n  10.0.0.5 4 65003              0         0    0    0 00:05:00 Active");
    expect(bgp.map((p) => [p.neighbor, p.state, p.prefixes])).toEqual([["10.0.0.1", "Established", 2], ["10.0.0.5", "Active", null]]);
  });
  it("reads CIDR config into the same shape the IOS parser gives", () => {
    const cfg = parseEosConfig(`hostname leaf1
interface Ethernet1
   no switchport
   ip address 10.0.0.0/31
   ip ospf area 0.0.0.0
interface Ethernet2
   shutdown
router ospf 1
   router-id 1.1.1.1
   network 10.0.0.0/31 area 0.0.0.0
   passive-interface Loopback0`);
    expect(cfg.hostname).toBe("leaf1");
    expect(cfg.interfaces.get("Ethernet1")).toMatchObject({ ip: "10.0.0.0", plen: 31, ospf: { pid: "1", area: "0" } });
    expect(cfg.interfaces.get("Ethernet2")?.shutdown).toBe(true);
    expect(cfg.ospf).toMatchObject({ routerId: "1.1.1.1", passive: ["Loopback0"] });
    expect(cfg.ospf?.networks[0]).toEqual({ addr: "10.0.0.0", wildcard: "0.0.0.1", area: "0" });
  });
  it("reads ping and declines to claim switching state it does not collect", () => {
    expect(parseEosPing("5 packets transmitted, 4 received, 20% packet loss, time 4ms")).toMatchObject({ successRate: 80, sent: 5 });
    expect(keysFor("l2switch", driverFor("eos")!)).toEqual(["brief", "config"]);
    expect(driverFor("unknown")).toBeNull();
  });
});

describe("neighbour tables", () => {
  it("parses real CDP detail captured from IOSv", () => {
    const n = parseCdpDetail(`-------------------------
Device ID: Manchester-PE-01
Entry address(es):
  IP address: 192.168.10.1
Platform: Cisco ,  Capabilities: Router Source-Route-Bridge
Interface: GigabitEthernet0/0,  Port ID (outgoing port): GigabitEthernet0/0
Holdtime : 162 sec
-------------------------
Device ID: Paris-PE-01
Entry address(es):
  IP address: 192.168.20.1
Platform: Cisco ,  Capabilities: Router Source-Route-Bridge
Interface: GigabitEthernet0/2,  Port ID (outgoing port): GigabitEthernet0/2`);
    expect(n.map((x) => [x.name, x.address, x.localIf, x.remoteIf])).toEqual([
      ["Manchester-PE-01", "192.168.10.1", "GigabitEthernet0/0", "GigabitEthernet0/0"], ["Paris-PE-01", "192.168.20.1", "GigabitEthernet0/2", "GigabitEthernet0/2"],
    ]);
  });
  it("parses LLDP detail in the IOS and EOS layouts", () => {
    const ios = parseLldpDetail(`------------------------------------------------
Local Intf: Gi0/1
Chassis id: aabb.cc00.0100
Port id: Gi0/0
System Name: R2

System Description:
Cisco IOS Software
System Capabilities: B,R
Enabled Capabilities: R
Management Addresses:
    IP: 10.0.0.2`);
    expect(ios[0]).toMatchObject({ name: "R2", address: "10.0.0.2", localIf: "GigabitEthernet0/1", remoteIf: "GigabitEthernet0/0" });
    const eos = parseLldpDetail(`Interface Ethernet1 detected 1 LLDP neighbors:

  Neighbor 0050.5600.0001/Ethernet1, age 5 seconds
  - Port ID type: Interface name (5)
    Port ID        : "Ethernet1"
  - System Name: "spine1.example.com"
  - System Description: "Arista Networks EOS version 4.27.0F"
    Enabled Capabilities: Bridge, Router
  - Management Address Subtype: IPv4 (1)
    Management Address        : 10.0.0.1`);
    expect(eos[0]).toMatchObject({ name: "spine1", address: "10.0.0.1", localIf: "Ethernet1", remoteIf: "Ethernet1" });
  });

  it("crawls neighbours within its caps and never beyond them", async () => {
    const tables: Record<string, Record<string, string>> = {
      "10.0.0.1": { "show running-config | include ^hostname": "hostname A", "show cdp neighbors detail": cdp("B", "10.0.0.2", "Gi0/1", "Gi0/0", "Router"), "show lldp neighbors detail": "% LLDP is not enabled" },
      "10.0.0.2": { "show running-config | include ^hostname": "hostname B", "show cdp neighbors detail": cdp("A", "10.0.0.1", "Gi0/0", "Gi0/1", "Router") + cdp("C", "10.0.0.3", "Gi0/2", "Gi0/0", "Router") + cdp("phone", "10.9.9.9", "Gi0/3", "eth0", "Host"), "show lldp neighbors detail": "% LLDP is not enabled" },
      "10.0.0.3": { "show running-config | include ^hostname": "hostname C", "show cdp neighbors detail": cdp("B", "10.0.0.2", "Gi0/0", "Gi0/2", "Router"), "show lldp neighbors detail": "" },
    };
    const transportFor = (address: string) => ({ run: async (_d: unknown, c: string) => (tables[address]?.[c] !== undefined ? { ok: true, text: tables[address][c] } : { ok: false, text: "unreachable" }) });
    const full = await crawl({ seeds: [{ address: "10.0.0.1", platform: "ios" }], maxDevices: 10, maxDepth: 5 }, transportFor);
    expect(full.devices.map((d) => [d.name, d.inspected])).toEqual([["A", true], ["B", true], ["C", true], ["phone", false]]);
    expect(full.links).toHaveLength(3); // A-B, B-C, B-phone: each cable once, not once per end
    const shallow = await crawl({ seeds: [{ address: "10.0.0.1", platform: "ios" }], maxDevices: 10, maxDepth: 1 }, transportFor);
    expect(shallow.devices.find((d) => d.name === "C")?.inspected).toBe(false); // seen, not followed past the depth cap
    const capped = await crawl({ seeds: [{ address: "10.0.0.1", platform: "ios" }], maxDevices: 2, maxDepth: 5 }, transportFor);
    expect(capped.warnings.join()).toMatch(/Stopped at 2 devices/);
  });
});

function cdp(name: string, ip: string, local: string, remote: string, caps: string) {
  return `-------------------------\nDevice ID: ${name}\nEntry address(es): \n  IP address: ${ip}\nPlatform: Cisco ,  Capabilities: ${caps} \nInterface: ${local},  Port ID (outgoing port): ${remote}\nHoldtime : 150 sec\n`;
}

describe("NetBox provider", () => {
  const route = (url: string): unknown => {
    const u = new URL(url);
    if (u.pathname === "/api/dcim/sites/" && u.searchParams.get("slug")) return { results: [{ id: 1, name: "London", slug: "london", tags: [{ slug: "lab" }] }], next: null };
    if (u.pathname === "/api/dcim/sites/") return { results: [{ id: 1, name: "London", slug: "london", tags: [{ slug: "lab" }], device_count: 2 }, { id: 2, name: "Paris", slug: "paris", tags: [], device_count: 0 }], next: null };
    if (u.pathname === "/api/dcim/devices/") return { results: [
      { id: 1, name: "lon-r1", role: { slug: "router" }, platform: { slug: "cisco-ios-xe" }, primary_ip4: { address: "10.1.1.1/24" } },
      { id: 2, name: "lon-sw1", role: { slug: "access-switch" }, platform: { slug: "arista-eos" }, primary_ip: null },
    ], next: null };
    if (u.pathname === "/api/dcim/cables/") return { results: [
      { id: 7, a_terminations: [{ object: { name: "Gi0/1", device: { name: "lon-r1" } } }], b_terminations: [{ object: { name: "Ethernet1", device: { name: "lon-sw1" } } }] },
      { id: 8, a_terminations: [{ object: { name: "Gi0/2", device: { name: "lon-r1" } } }], b_terminations: [{ object: { name: "Gi9", device: { name: "elsewhere" } } }] },
    ], next: null };
    return { results: [], next: null };
  };
  const http = (async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe("Token t0ken");
    return new Response(JSON.stringify(route(url)), { status: 200 });
  }) as unknown as typeof fetch;
  const nb = () => new NetboxProvider({ url: "https://nb.example", token: "t0ken", username: "admin", password: "env:X", defaultEnvironment: "production" }, http, 0);

  it("lists sites as networks, production unless tagged lab", async () => {
    const s = await nb().listScopes();
    expect(s.map((x) => [x.id, x.environment])).toEqual([["netbox:london", "lab"], ["netbox:paris", "production"]]);
  });
  it("builds a topology from devices and cables, and says what it left out", async () => {
    const t = await nb().getTopology("netbox:london");
    expect(t.nodes.map((n) => [n.label, n.kind, n.platform, n.address])).toEqual([["lon-r1", "router", "ios", "10.1.1.1"], ["lon-sw1", "l2switch", "eos", undefined]]);
    expect(t.links).toHaveLength(1);
    expect(t.warnings.join()).toMatch(/outside this site/);
    expect(t.warnings.join()).toMatch(/no primary IP/);
    expect(t.lab.environment).toBe("lab");
  });
  it("says so when the token is refused", async () => {
    const denied = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(new NetboxProvider({ url: "https://nb.example", token: "x", username: "", defaultEnvironment: "production" }, denied).listScopes()).rejects.toThrow(/refused the API token/);
  });
  it("does not offer a device it has no address for", async () => {
    const p = nb();
    const t = await p.getTopology("netbox:london");
    expect(p.inspectable(t.nodes[0])).toEqual({ ok: true });
    expect(p.inspectable(t.nodes[1])).toMatchObject({ ok: false, reason: expect.stringMatching(/no primary IP/i) });
  });
});

describe("diagnostics over SSH against an inventory file (no CML involved)", () => {
  let r1: FakeDevice, r2: FakeDevice, dir: string;
  beforeEach(async () => {
    process.env.TS_TEST_PW = "secret";
    r1 = await startFakeDevice({ host: "R1", answers: {
      "show ip interface brief": brief([["GigabitEthernet0/0", "10.0.0.1", "up", "up"], ["GigabitEthernet0/1", "unassigned", "administratively down", "down"]]),
      "show running-config": "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\ninterface GigabitEthernet0/1\n no ip address\n shutdown\n",
      "show ip ospf neighbor": "", "show ip bgp summary": "% BGP not active",
    } });
    r2 = await startFakeDevice({ host: "R2", answers: {
      "show ip interface brief": brief([["GigabitEthernet0/0", "10.0.0.2", "administratively down", "down"]]),
      "show running-config": "hostname R2\ninterface GigabitEthernet0/0\n ip address 10.0.0.2 255.255.255.0\n shutdown\n",
      "show ip ospf neighbor": "", "show ip bgp summary": "% BGP not active",
    } });
    dir = mkdtempSync(join(tmpdir(), "ts-inv-"));
    const file = join(dir, "inventory.yaml");
    writeFileSync(file, INV.replace("{ name: R1, address: 127.0.0.1, platform: ios }", `{ name: R1, address: 127.0.0.1, port: ${r1.port}, platform: ios }`).replace("{ name: R2, address: 127.0.0.1, platform: ios }", `{ name: R2, address: 127.0.0.1, port: ${r2.port}, platform: ios }`));
    setContext({ db: openDatabase(":memory:"), mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, anthropic: null, lastConnectAttempt: 0 });
    setProviders([new StaticProvider(file)]);
  });
  afterEach(() => { r1.close(); r2.close(); setProviders(null); setContext(undefined); });

  it("lists the site, resolves its provider by id, and inspects real SSH devices", async () => {
    expect(providerFor("static:hq").provider?.id).toBe("static");
    const { run, findings } = await runDiagnostics("static:hq", { pings: true });
    expect(run.devices.map((d) => [d.label, d.inspected, d.commandsFailed])).toEqual([["R1", true, 0], ["R2", true, 0]]);
    const f = findings.find((x) => x.kind === "interface-admin-down");
    expect(f).toMatchObject({ device: "R2", status: "confirmed", severity: "warning" });
    expect(f?.evidence.join("\n")).toContain("R1# show ip interface brief");
    expect(r1.sent).not.toContain("configure terminal"); // diagnostics never touches configuration
    expect(r2.sent.filter((l) => !/^(show|terminal)/.test(l))).toEqual([]);
  });

  it("marks an unreachable device not inspected, with the reason, and concludes nothing about it", async () => {
    r2.close();
    const { run, findings } = await runDiagnostics("static:hq", { pings: false });
    const d = run.devices.find((x) => x.label === "R2")!;
    expect(d.inspected).toBe(false);
    expect(d.reason).toMatch(/Every command failed\. .*(not reachable|timed out|closed)/);
    expect(findings.filter((x) => x.device === "R2")).toEqual([]);
  });
});
