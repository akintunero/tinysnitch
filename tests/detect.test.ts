import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRunning } from "@/lib/provisioning/detect";

const file = join(__dirname, "fixtures", "captured-iolxe", "London__show_running_config.txt");
const by = (cfg: string) => Object.fromEntries(detectRunning(cfg).map((r) => [r.id, r.detail]));

describe.skipIf(!existsSync(file))("a real IOL-XE configuration", () => {
  const got = by(readFileSync(file, "utf8"));
  it("recognises the routing protocols the lab runs", () => {
    expect(got.bgp).toMatch(/^AS 65100, 3 neighbours$/);
    expect(got.isis).toBeDefined();
    expect(got.loopback).toBe("2 interfaces");
  });
});

describe("written-out configurations", () => {
  it("reads what is configured and counts it", () => {
    const g = by("hostname R1\nvlan 10\nvlan 20\nvrf definition RED\nip route 0.0.0.0 0.0.0.0 10.0.0.1\nntp server 1.1.1.1\nntp server 2.2.2.2\nlogging host 9.9.9.9\nip name-server 8.8.8.8\nsnmp-server location lab\nsnmp-server contact me\nip ssh version 2\nip access-list extended WEB\nrouter ospf 1\n network 10.0.0.0 0.0.0.255 area 0\ninterface Vlan10\n ip helper-address 10.9.9.9\n standby 1 ip 10.0.0.254\ninterface Port-channel1\n");
    expect(g).toMatchObject({ vlan: "2 VLANs", vrf: "RED", static: "1 route", ntp: "1.1.1.1, 2.2.2.2", syslog: "9.9.9.9", dns: "8.8.8.8", snmp: "location, contact", ssh: "version 2", acl: "1 list", ospf: "process 1, 1 area", svi: "1 interface", "dhcp-relay": "1 interface", fhrp: "1 group", lag: "1 bundle" });
  });
  it("says nothing for a configuration that runs none of it, and is not fooled by indented or commented lines", () => {
    expect(detectRunning("hostname R1\n!\ninterface Ethernet0/0\n shutdown\n")).toEqual([]);
    expect(by("! router bgp 65000\n description router bgp 1\n")).not.toHaveProperty("bgp");
  });
});
