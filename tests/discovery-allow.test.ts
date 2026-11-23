import { describe, expect, it } from "vitest";
import { inRanges, ipToInt, parseRange, type Range } from "@/lib/core/cidr";
import { crawl } from "@/lib/providers/discovery";
import { InventoryError, parseInventory } from "@/lib/providers/inventory-file";

const ok = (e: string) => { const r = parseRange(e); if (typeof r === "string") throw new Error(r); return r; };

describe("address ranges", () => {
  it("reads an address or a range, and rounds a range down to its network", () => {
    expect(ok("10.0.0.5")).toMatchObject({ start: ipToInt("10.0.0.5"), end: ipToInt("10.0.0.5") });
    expect(ok("10.1.2.3/24")).toMatchObject({ start: ipToInt("10.1.2.0"), end: ipToInt("10.1.2.255") });
    expect(ok("10.0.0.0/8")).toMatchObject({ start: ipToInt("10.0.0.0"), end: ipToInt("10.255.255.255") });
  });
  it("decides membership at the edges, and never for anything that is not an IPv4 address", () => {
    const r: Range[] = [ok("10.0.0.0/24")];
    expect(inRanges("10.0.0.0", r)).toBe(true);
    expect(inRanges("10.0.0.255", r)).toBe(true);
    expect(inRanges("10.0.1.0", r)).toBe(false);
    expect(inRanges("9.255.255.255", r)).toBe(false);
    for (const x of ["core1.example.com", "::1", "", null, undefined, "10.0.0", "10.0.0.256", "10.0.0.1.5", "010.0.0.1"]) expect(inRanges(x as string, r), String(x)).toBe(false);
  });
  it("refuses entries that are wrong or too wide to be a device list", () => {
    for (const bad of ["", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/a", "10.0.0/24", "host.example.com", "10.0.0.0/24/1", "0.0.0.0/0", "10.0.0.0/7", "::/0"]) expect(typeof parseRange(bad), bad).toBe("string");
  });
});

describe("a crawl with an allow-list", () => {
  const cdp = (name: string, ip: string, local: string, remote: string, caps = "Router") => `-------------------------\nDevice ID: ${name}\nEntry address(es): \n  IP address: ${ip}\nPlatform: Cisco ,  Capabilities: ${caps} \nInterface: ${local},  Port ID (outgoing port): ${remote}\nHoldtime : 150 sec\n`;
  const tables: Record<string, string> = {
    "10.0.0.1": cdp("B", "10.0.0.2", "Gi0/1", "Gi0/0") + cdp("isp-edge", "203.0.113.1", "Gi0/2", "Gi0/0"),
    "10.0.0.2": cdp("A", "10.0.0.1", "Gi0/0", "Gi0/1") + cdp("partner", "192.0.2.9", "Gi0/2", "Gi0/0"),
    "203.0.113.1": cdp("farther", "10.0.0.50", "Gi0/0", "Gi0/0"),
  };
  const asked: string[] = [];
  const transportFor = (address: string) => { asked.push(address); return { run: async (_d: unknown, c: string) => c.includes("hostname") ? { ok: true, text: `hostname H${address.replace(/\D/g, "")}` } : c.includes("cdp") ? { ok: true, text: tables[address] ?? "" } : { ok: false, text: "% not enabled" } }; };
  const seeds = [{ address: "10.0.0.1", platform: "ios" as const }];

  it("never opens a connection to an address outside the list, and says what it left alone", async () => {
    asked.length = 0;
    const r = await crawl({ seeds, maxDevices: 20, maxDepth: 5, allow: ["10.0.0.0/24"] }, transportFor);
    expect(asked.sort()).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(r.devices.filter((d) => d.inspected).length).toBe(2);
    expect(r.devices.find((d) => d.name === "isp-edge")).toMatchObject({ inspected: false, note: expect.stringContaining("outside the allow-list") });
    expect(r.devices.find((d) => d.name === "farther")).toBeUndefined(); // only reachable through the outside device
    expect(r.warnings.join()).toMatch(/outside the allow-list: .*isp-edge \(203\.0\.113\.1\).*partner \(192\.0\.2\.9\)|outside the allow-list: .*partner \(192\.0\.2\.9\).*isp-edge \(203\.0\.113\.1\)/);
  });

  it("follows everything inside a wider list, so the list and not the depth is what bounds it", async () => {
    asked.length = 0;
    await crawl({ seeds, maxDevices: 20, maxDepth: 5, allow: ["10.0.0.0/24", "203.0.113.0/24"] }, transportFor);
    expect(asked).toContain("203.0.113.1");
    expect(asked).toContain("10.0.0.50");
    expect(asked).not.toContain("192.0.2.9");
  });
});

describe("the allow-list in the inventory file", () => {
  const inv = (extra: string, seed = "10.0.0.1") => `credentials:\n  c: { username: u, password: "env:P" }\ndiscovery:\n  - id: d\n    title: D\n    environment: lab\n    credential: c\n    seeds: [{ address: ${seed}, platform: ios }]\n${extra}`;
  it("accepts a list that covers the seed", () => {
    expect(parseInventory(inv("    allow: [10.0.0.0/16, 172.16.1.0/24]\n")).discovery[0].allow).toEqual(["10.0.0.0/16", "172.16.1.0/24"]);
  });
  it("is required: a crawl with no allow-list is refused with a message that says what to add", () => {
    expect(() => parseInventory(inv(""))).toThrow(/discovery\.0\.allow/);
    expect(() => parseInventory(inv("    allow: []\n"))).toThrow(/list the address ranges/);
  });
  it("refuses a seed outside the list, a bad entry and a range wider than /8", () => {
    expect(() => parseInventory(inv("    allow: [192.168.0.0/16]\n"))).toThrow(InventoryError);
    expect(() => parseInventory(inv("    allow: [192.168.0.0/16]\n"))).toThrow(/seed 10\.0\.0\.1 is not inside/);
    expect(() => parseInventory(inv("    allow: [nonsense]\n"))).toThrow(/not an IPv4 address/);
    expect(() => parseInventory(inv("    allow: [0.0.0.0/0]\n"))).toThrow(/wider than \/8/);
  });
});
