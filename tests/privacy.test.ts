import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { MessagesClient } from "@/lib/llm/loop";
import { runToolLoop } from "@/lib/llm/loop";
import { pseudonymisingClient } from "@/lib/privacy/client";
import { Pseudonymiser, StreamRestorer } from "@/lib/privacy/pseudonym";

const key = Buffer.from("k".repeat(32));
const make = () => new Pseudonymiser({ key, devices: ["London", "Hamburg", "lon-core1"], networks: ["netclan-lab"] });

const CONFIG = `hostname London
ip domain-name corp.acme-bank.com
username alice privilege 15 secret 9 $9$abc
interface Ethernet0/2
 description Uplink to Hamburg, circuit ID 88231 (Acme Bank DC1)
 ip address 10.0.15.1 255.255.255.252
 mac-address aabb.cc00.1000
router bgp 65100
 neighbor 10.0.15.2 remote-as 65201
 neighbor 172.16.4.9 remote-as 65100
 network 203.0.113.0 mask 255.255.255.0
access-list 10 permit 10.0.15.0 0.0.0.3
snmp-server location Frankfurt DC2 rack 14
banner motd ^C Authorised use only. Acme Bank. ^C
ipv6 address 2001:db8:abcd:12::1/64
`;

describe("masking what leaves", () => {
  const p = make();
  const out = p.forward(CONFIG);

  it("leaves none of the identifying values in the outgoing text", () => {
    for (const real of ["10.0.15.1", "10.0.15.2", "10.0.15.0", "172.16.4.9", "203.0.113.0", "London", "Hamburg", "acme-bank", "corp.acme", "alice", "aabb.cc00.1000", "Frankfurt", "Acme Bank", "88231", "2001:db8:abcd:12::1", "abcd:12"]) {
      expect(out, real).not.toContain(real);
    }
  });

  it("does not touch what is not identifying: masks, wildcards, ASNs and the structure of the config", () => {
    expect(out).toContain("255.255.255.252");
    expect(out).toContain("255.255.255.0");
    expect(out).toContain("0.0.0.3");
    expect(out).toContain("router bgp 65100");
    expect(out).toContain("remote-as 65201");
    expect(out).toContain("interface Ethernet0/2");
    expect(out).toContain("description [removed]");
    expect(out).toContain("banner motd [removed]");
  });

  it("keeps addresses in one subnet in one subnet, and private addresses private", () => {
    const a = p.forward("10.0.15.1");
    const b = p.forward("10.0.15.2");
    expect(a.split(".").slice(0, 3)).toEqual(b.split(".").slice(0, 3));
    expect(a).not.toBe("10.0.15.1");
    expect(a.startsWith("10.")).toBe(true);
    expect(p.forward("172.16.4.9").startsWith("172.")).toBe(true);
    expect(p.forward("203.0.113.7").startsWith("203.")).toBe(true);
    const net = p.forward("10.0.15.0");
    expect(net.split(".").slice(0, 3)).toEqual(a.split(".").slice(0, 3));
  });

  it("gives the same stand-in every time and a different one to different addresses", () => {
    expect(p.forward("10.0.15.1")).toBe(p.forward("10.0.15.1"));
    expect(p.forward("10.0.15.1")).not.toBe(p.forward("10.0.15.2"));
    const many = Array.from({ length: 200 }, (_, i) => `10.${i % 5}.${i}.1`);
    expect(new Set(many.map((x) => p.forward(x))).size).toBe(many.length);
  });

  it("learns names the text itself declares, so a hostname nobody registered is still hidden", () => {
    const q = new Pseudonymiser({ key });
    const t = q.forward("hostname edge-fra-07\nping edge-fra-07 via 192.0.2.44");
    expect(t).not.toContain("edge-fra-07");
    expect(t).not.toContain("192.0.2.44");
  });

  it("round-trips: restoring the masked text gives back the original (apart from what was removed outright)", () => {
    const r = make();
    const masked = r.forward(CONFIG);
    const restored = r.restore(masked);
    expect(restored).toBe(CONFIG.replace(/description .*/, "description [removed]").replace(/(snmp-server location ).*/, "$1[removed]").replace(/banner motd [\s\S]*?\^C [\s\S]*?\^C/, "banner motd [removed]"));
  });

  it("restores only what it issued: other addresses and words the model writes stay as written", () => {
    const r = make();
    r.forward("10.0.15.1 London");
    expect(r.restore("Use RFC 1918 space such as 192.168.0.1 and 8.8.8.8, or the word dev-99.")).toBe("Use RFC 1918 space such as 192.168.0.1 and 8.8.8.8, or the word dev-99.");
  });

  it("handles IPv6, and MAC addresses in each notation", () => {
    const r = make();
    const t = r.forward("2001:db8::1 fe80::a8bb:ccff:fe00:1000 aa:bb:cc:00:10:00 aabb-cc00-1000".replace("aabb-cc00-1000", "aa-bb-cc-00-10-01"));
    expect(t).not.toContain("2001:db8::1");
    expect(t).not.toMatch(/aa:bb:cc:00:10:00/i);
    expect(t).not.toContain("aa-bb-cc-00-10-01");
    expect(r.restore(r.forward("2001:db8::1"))).toBe("2001:db8::1");
    expect(r.restore(r.forward("aabb.cc00.1000"))).toBe("aabb.cc00.1000");
    expect(r.restore(r.forward("AA:BB:CC:00:10:00"))).toBe("aa:bb:cc:00:10:00");
  });

  it("does not mistake version strings, times or ports for addresses", () => {
    const r = make();
    const s = "IOS XE Version 17.9.4, uptime 12:30:45, tcp/179, ntp 3.14";
    expect(r.forward(s)).toBe(s);
  });
});

const OBJECTS = `ip vrf ACME-BANK-EDGE
route-map ACME-BANK-OUT permit 10
 match ip address prefix-list ACME-PL-V4
router bgp 65100
 neighbor GLOBEX-RR peer-group
 neighbor 10.0.15.2 remote-as 15169
 neighbor 10.0.15.6 remote-as 64600
ip access-list extended GUEST-WIFI-IN
 permit ip any any
interface Ethernet0/1
 ip access-group GUEST-WIFI-IN in
 service-policy output QOS-ACME
ntp server ntp1.acme-bank.com
`;

describe("configuration object names, AS numbers and your own terms", () => {
  const p = make();
  const out = p.forward(OBJECTS);

  it("hides the identifying words in the names of route-maps, prefix-lists, ACLs, VRFs, peer-groups and policies", () => {
    for (const real of ["ACME", "BANK", "GLOBEX", "ntp1.acme-bank.com"]) expect(out, real).not.toContain(real);
    expect(out).toContain("permit ip any any"); // the structure, and the keywords, stay
    expect(p.restore(out)).toBe(OBJECTS);
  });

  it("keeps the generic words of a name, so the purpose can still be read", () => {
    expect(out).toMatch(/route-map obj-[0-9a-f]{6}-OUT permit 10/); // ACME-BANK-OUT
    expect(out).toMatch(/prefix-list obj-[0-9a-f]{6}-PL-V4/); // ACME-PL-V4
    expect(out).toMatch(/peer-group|neighbor obj-[0-9a-f]{6}-RR peer-group/); // GLOBEX-RR
    expect(out).toContain("ip access-list extended GUEST-WIFI-IN"); // every word generic: left as it is
    expect(out).toContain("ip access-group GUEST-WIFI-IN in");
    expect(out).toMatch(/service-policy output QOS-obj-[0-9a-f]{6}/); // QOS is generic, ACME is not
    expect(out).toMatch(/ip vrf obj-[0-9a-f]{6}-obj|ip vrf obj-[0-9a-f]{6}/); // ACME-BANK-EDGE: ACME-BANK hidden as one run
  });

  it("replaces a word it does not know, and keeps one you add as safe", () => {
    const text = "route-map VOICE-FRANKFURT-OUT permit 10";
    const strict = new Pseudonymiser({ key }).forward(text);
    expect(strict).not.toContain("FRANKFURT");
    expect(strict).toMatch(/route-map VOICE-obj-[0-9a-f]{6}-OUT/); // VOICE and OUT are on the built-in list, FRANKFURT is not
    const mine = new Pseudonymiser({ key, safeWords: ["frankfurt"] }).forward(text);
    expect(mine).toBe(text);
  });

  it("hides a public AS number everywhere it is labelled, keeps private ones, and restores both ways", () => {
    expect(out).not.toContain("15169");
    expect(out).toContain("remote-as 64600");
    expect(out).toContain("router bgp 65100");
    const row = "10.0.15.2       4       15169     120     118        7    0    0 00:10:02        3";
    const masked = p.forward(row);
    expect(masked).not.toContain("15169");
    expect(p.forward("local AS number 15169")).toMatch(/local AS number 42\d{8}$/);
    expect(p.restore(masked)).toBe(row.replace("10.0.15.2", "10.0.15.2"));
  });

  it("hides the words you list, wherever they occur", () => {
    const q = new Pseudonymiser({ key, terms: ["Project Falcon", "Globex"] });
    const t = q.forward("Globex asked about Project Falcon; see GLOBEX-UPLINK and Globex.");
    expect(t).not.toContain("Globex");
    expect(t).not.toContain("Project Falcon");
    expect(t).toContain("GLOBEX-UPLINK"); // a different word: only the listed one is touched
    expect(q.restore(t)).toBe("Globex asked about Project Falcon; see GLOBEX-UPLINK and Globex.");
  });

  it("does not take command keywords for names", () => {
    const q = new Pseudonymiser({ key });
    const s = "show ip vrf brief\nshow ip route vrf all\nshow ip prefix-list summary";
    expect(q.forward(s)).toBe(s);
  });
});

describe("network addresses stay valid", () => {
  const p = make();
  const parts = (ip: string) => ip.split(".").map(Number);
  const asInt = (ip: string) => parts(ip).reduce((n, o) => n * 256 + o, 0);

  it("keeps a /30 network address a network address, with its hosts inside it", () => {
    const net = asInt(p.forward("10.0.15.0"));
    const h1 = asInt(p.forward("10.0.15.1"));
    const h2 = asInt(p.forward("10.0.15.2"));
    expect(net % 4).toBe(0);
    expect(Math.floor(h1 / 4)).toBe(net / 4);
    expect(Math.floor(h2 / 4)).toBe(net / 4);
    expect(h1 % 4).toBe(1);
    expect(h2 % 4).toBe(2);
  });

  it("keeps a /16 network address a network address", () => {
    const net = asInt(p.forward("10.1.0.0"));
    const host = asInt(p.forward("10.1.5.7"));
    expect(net % 65536).toBe(0);
    expect(Math.floor(host / 65536)).toBe(net / 65536);
  });

  it("still hides the address (only the last octet is kept)", () => {
    expect(p.forward("10.0.15.1")).not.toBe("10.0.15.1");
    expect(p.forward("203.0.113.9").split(".").slice(1, 3)).not.toEqual(["0", "113"]);
  });
});

describe("stand-ins cannot be confused with real text", () => {
  it("never issues a stand-in that already appears in the real text, and restores only what it issued", () => {
    const probe = make().forward("London"); // what London would normally become
    const q = make();
    q.learn(`an interface description that happens to say ${probe}`);
    const issued = q.forward("London");
    expect(issued).not.toBe(probe);
    expect(q.restore(issued)).toBe("London");
    expect(q.restore(probe)).toBe(probe);
  });

  it("learns a name declared late in a request before masking the earlier part of it", () => {
    const q = new Pseudonymiser({ key });
    q.learn("why is R9 down?\nhostname R9\n");
    expect(q.forward("why is R9 down?")).not.toContain("R9");
  });
});

describe("streamed text", () => {
  it("restores a stand-in that arrives split across chunks", () => {
    const p = make();
    const fake = p.forward("London");
    const ip = p.forward("10.0.15.1");
    const text = `Check ${fake} first, then ${ip}. Done.`;
    for (const size of [1, 2, 3, 5, 7]) {
      const r = new StreamRestorer(p);
      let out = "";
      for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
      out += r.flush();
      expect(out, `chunks of ${size}`).toBe("Check London first, then 10.0.15.1. Done.");
    }
  });
});

describe("the Messages client wrapper", () => {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];

  /** A model that only ever sees stand-ins: it reads a device out of the prompt and asks a tool about it. */
  function fakeModel(): MessagesClient {
    let turn = 0;
    return {
      messages: {
        create: async (params) => {
          seen.push(JSON.parse(JSON.stringify(params)));
          turn += 1;
          const dump = JSON.stringify(params);
          const dev = /dev-[0-9a-f]{6}/.exec(dump)?.[0] ?? "";
          if (turn === 1) {
            return { id: "m1", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "show", input: { device: dev, command: "show ip interface brief" } }] } as unknown as Anthropic.Message;
          }
          return { id: "m2", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: `${dev} looks fine.` }] } as unknown as Anthropic.Message;
        },
      },
    };
  }

  it("sends only stand-ins, runs the tool with the real name, and shows the real name in the answer", async () => {
    seen.length = 0;
    const p = make();
    const executed: unknown[] = [];
    const result = await runToolLoop({
      client: pseudonymisingClient(fakeModel(), p),
      model: "x",
      system: "You work on netclan-lab.",
      messages: [{ role: "user", content: "Why is 10.0.15.2 down on London?" }],
      tools: [{ name: "show", inputSchema: { type: "object" } }],
      execute: async (_name, input) => {
        executed.push(input);
        return { content: "Ethernet0/2 10.0.15.1 up up\nhostname London\nmac aabb.cc00.1000", isError: false };
      },
    });
    expect(executed).toEqual([{ device: "London", command: "show ip interface brief" }]);
    expect(result.text).toBe("London looks fine.");
    const wire = JSON.stringify(seen);
    for (const real of ["London", "10.0.15.1", "10.0.15.2", "netclan-lab", "aabb.cc00.1000"]) expect(wire, real).not.toContain(real);
    expect(wire).toContain("dev-");
  });

  it("fails if masking is removed (the leak the test exists to catch)", async () => {
    seen.length = 0;
    await runToolLoop({ client: fakeModel(), model: "x", messages: [{ role: "user", content: "Why is 10.0.15.2 down on London?" }], tools: [], execute: async () => ({ content: "", isError: false }) });
    expect(JSON.stringify(seen)).toContain("10.0.15.2");
  });
});

describe("on a real captured lab", () => {
  const dir = join(__dirname, "fixtures", "captured-iolxe");
  const cfg = (() => { try { return readFileSync(join(dir, "London__show_running_config.txt"), "utf8"); } catch { return null; } })();
  it.skipIf(!cfg)("masks every IPv4 address in a real router config, except masks and wildcards", () => {
    const p = new Pseudonymiser({ key, devices: ["London", "Cornwall", "Paris", "Amsterdam", "Hamburg"] });
    const out = p.forward(cfg!);
    const addrs = (s: string) => [...s.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d]|\.\d)/g)].map((m) => m[0]);
    const keep = (a: string) => /^(255\.|0\.0\.0\.|0\.0\.|127\.|224\.|0\.0\.0\.0$)/.test(a);
    const real = addrs(cfg!).filter((a) => !keep(a));
    expect(real.length).toBeGreaterThan(5);
    const left = new Set(addrs(out));
    for (const a of real) expect(left.has(a), `${a} left unmasked`).toBe(false);
    expect(p.restore(out).replace(/\[removed\]/g, "")).toContain("router bgp");
  });
});
