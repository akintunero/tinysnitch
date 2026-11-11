import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEtherchannel, parseIpIntBrief, parseOspfNeighbors, parseRunningConfig, parseTrunk, parseVlanBrief } from "@/lib/diagnostics/parsers";

/**
 * Output captured with `npm run capture` from a real, running CML lab (IOSv and IOSvL2). These are the only tests
 * whose input did not come from this repository's author, so they are the ones to trust most.
 */
const dir = join(__dirname, "fixtures", "captured");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const have = existsSync(join(dir, "London__show_ip_interface_brief.txt"));

describe.skipIf(!have)("parsers on output captured from real IOSv / IOSvL2", () => {
  it("reads show ip interface brief", () => {
    const rows = parseIpIntBrief(read("London__show_ip_interface_brief.txt"));
    expect(rows).toEqual([
      { name: "GigabitEthernet0/0", ip: "192.168.10.2", status: "up", protocol: "up" },
      { name: "GigabitEthernet0/1", ip: null, status: "administratively down", protocol: "down" },
      { name: "GigabitEthernet0/2", ip: "192.168.20.2", status: "up", protocol: "up" },
      { name: "GigabitEthernet0/3", ip: null, status: "administratively down", protocol: "down" },
    ]);
  });

  it("reads the real running-config: hostname, addresses and shutdown", () => {
    const cfg = parseRunningConfig(read("London__show_running_config.txt"));
    expect(cfg.hostname).toBe("London-PE-01"); // the device's own name differs from the CML label "London"
    expect(cfg.interfaces.get("GigabitEthernet0/0")).toMatchObject({ ip: "192.168.10.2", plen: 24, shutdown: false });
    expect(cfg.interfaces.get("GigabitEthernet0/1")).toMatchObject({ ip: null, shutdown: true });
    expect(cfg.ospf).toBeNull();
    expect(cfg.bgp).toBeNull();
  });

  it("treats a quiet device honestly: no OSPF output is no neighbours, BGP-not-active is not a peer", () => {
    expect(parseOspfNeighbors(read("London__show_ip_ospf_neighbor.txt"))).toEqual([]);
    expect(read("London__show_ip_bgp_summary.txt")).toMatch(/^%/);
  });

  it("reads the switch: VLAN ports, no trunks, no EtherChannels", () => {
    const vlans = parseVlanBrief(read("London-ME-01__show_vlan_brief.txt"));
    expect(vlans.get("GigabitEthernet0/1")).toBe("1");
    expect(parseTrunk(read("London-ME-01__show_interfaces_trunk.txt"))).toEqual([]);
    expect(parseEtherchannel(read("London-ME-01__show_etherchannel_summary.txt"))).toEqual([]);
  });
});
