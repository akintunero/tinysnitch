import { afterEach, describe, expect, it } from "vitest";
import { GET as catalogGet } from "@/app/api/provisioning/route";
import { POST as renderPost } from "@/app/api/provisioning/render/route";
import { POST as removePost } from "@/app/api/changes/remove/route";
import { blockedLines } from "@/lib/core/safety";
import type { Platform } from "@/lib/core/types";
import { createChange, getChange, updateChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { listAudit } from "@/lib/database/repo";
import { CATALOG, ProvisionError, renderFor, serviceById, validate } from "@/lib/provisioning/catalog";
import { setProviders } from "@/lib/providers/registry";
import { setContext } from "@/lib/server/context";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticProvider } from "@/lib/providers/static";

const def = (id: string) => serviceById(id)!;
const render = (id: string, p: Platform, v: Record<string, string | number | boolean>) => def(id).render(p, validate(def(id), v));

describe("the service catalogue renders for each platform", () => {
  it("makes a VLAN on IOS, EOS, NX-OS and Junos", () => {
    expect(render("vlan", "ios", { id: 110, name: "USERS" })).toEqual(["vlan 110", " name USERS"]);
    expect(render("vlan", "nxos", { id: 110, name: "USERS" })).toEqual(["vlan 110", " name USERS"]);
    expect(render("vlan", "junos", { id: 110, name: "USERS" })).toEqual(["set vlans USERS vlan-id 110"]);
  });
  it("addresses a routed interface with a mask on IOS and a prefix length elsewhere", () => {
    expect(render("routed-interface", "ios", { interface: "GigabitEthernet0/1", address: "10.0.12.1/30", description: "to London" })).toEqual(["interface GigabitEthernet0/1", " description to London", " ip address 10.0.12.1 255.255.255.252", " no shutdown"]);
    expect(render("routed-interface", "eos", { interface: "Ethernet1", address: "10.0.12.1/30" })).toEqual(["interface Ethernet1", " no switchport", " ip address 10.0.12.1/30", " no shutdown"]);
    expect(render("routed-interface", "junos", { interface: "ge-0/0/1", address: "10.0.12.1/30" })).toEqual(["set interfaces ge-0/0/1 unit 0 family inet address 10.0.12.1/30"]);
  });
  it("computes subnet masks correctly for odd prefix lengths", () => {
    const masks: Record<number, string> = { 0: "0.0.0.0", 8: "255.0.0.0", 17: "255.255.128.0", 23: "255.255.254.0", 30: "255.255.255.252", 32: "255.255.255.255" };
    for (const [len, mask] of Object.entries(masks)) {
      expect(render("routed-interface", "ios", { interface: "Gi0/0", address: `10.1.2.3/${len}` })[1]).toBe(` ip address 10.1.2.3 ${mask}`);
    }
  });
  it("writes a static route in each platform's own form, with an optional distance", () => {
    const v = { prefix: "192.168.50.0/24", nexthop: "10.0.12.2" };
    expect(render("static-route", "ios", v)).toEqual(["ip route 192.168.50.0 255.255.255.0 10.0.12.2"]);
    expect(render("static-route", "eos", { ...v, distance: 200 })).toEqual(["ip route 192.168.50.0/24 10.0.12.2 200"]);
    expect(render("static-route", "junos", { ...v, distance: 200 })).toEqual(["set routing-options static route 192.168.50.0/24 next-hop 10.0.12.2 preference 200"]);
  });
  it("adds a BGP neighbour in the platform's structure", () => {
    const v = { local: 65100, neighbor: "10.0.15.2", remote: 65200 };
    expect(render("bgp-neighbor", "ios", v)).toEqual(["router bgp 65100", " neighbor 10.0.15.2 remote-as 65200", " address-family ipv4", "  neighbor 10.0.15.2 activate"]);
    expect(render("bgp-neighbor", "nxos", v)).toContain("  remote-as 65200");
    expect(render("bgp-neighbor", "junos", v)).toContain("set protocols bgp group EXTERNAL neighbor 10.0.15.2 peer-as 65200");
  });
  it("carries a trunk's VLAN list through, and refuses a platform it has no rendering for", () => {
    expect(render("trunk-port", "eos", { interface: "Ethernet3", vlans: "10, 20,30-40" })).toEqual(["interface Ethernet3", " switchport mode trunk", " switchport trunk allowed vlan 10,20,30-40"]);
    expect(() => render("svi", "junos", { vlan: 10, address: "10.10.10.1/24" })).toThrow(/not available/);
  });

  it("never produces a line the safety rules would block, for any service on any platform", () => {
    const sample: Record<string, Record<string, string | number | boolean>> = {
      vlan: { id: 10, name: "USERS" }, "access-port": { interface: "Gi0/1", vlan: 10, description: "pc" }, "trunk-port": { interface: "Gi0/2", vlans: "10,20" },
      "routed-interface": { interface: "Gi0/3", address: "10.0.0.1/30" }, svi: { vlan: 10, address: "10.10.10.1/24" }, "static-route": { prefix: "10.9.0.0/16", nexthop: "10.0.0.2" },
      "ospf-interface": { interface: "Gi0/3", area: 0 }, "bgp-neighbor": { local: 65100, neighbor: "10.0.0.2", remote: 65200 }, ntp: { server: "10.0.0.9" },
      syslog: { host: "10.0.0.8" }, "interface-state": { interface: "Gi0/4", description: "spare", up: false },
      loopback: { number: 0, address: "10.255.0.1/32" }, "ospf-router-id": { routerid: "10.255.0.1" }, vrf: { name: "CUST_A" },
      "port-channel": { id: 1, members: "Gi0/5, Gi0/6", mode: "active", description: "uplink" }, mtu: { interface: "Gi0/7", mtu: 9000 },
      "acl-entry": { name: "GUEST_IN", action: "deny", protocol: "tcp", source: "10.0.0.0/24", destination: "any", port: 22 }, "acl-apply": { interface: "Gi0/8", name: "GUEST_IN", direction: "in" },
      hardening: { ssh2: true, http: true, enc: true, vty: true }, hsrp: { interface: "Gi0/9", group: 1, vip: "10.0.0.254", priority: 110 },
      "dhcp-relay": { interface: "Gi0/10", server: "10.0.0.5" }, dns: { server: "10.0.0.53" }, hostname: { hostname: "edge-1", domain: "example.net" }, "snmp-info": { location: "Frankfurt DC2", contact: "noc@example.net" },
    };
    for (const svc of CATALOG) {
      expect(sample[svc.id], `a sample for ${svc.id}`).toBeDefined();
      for (const p of svc.platforms) {
        const lines = render(svc.id, p, sample[svc.id]);
        expect(lines.length, `${svc.id} on ${p}`).toBeGreaterThan(0);
        expect(blockedLines(lines, p), `${svc.id} on ${p}`).toEqual([]);
        for (const l of lines) expect(l, `${svc.id} on ${p}`).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });
});

describe("the rest of the catalogue", () => {
  it("writes an ACL entry the way each platform wants it: wildcard masks on IOS, prefixes elsewhere, host for a /32", () => {
    const v = { name: "GUEST_IN", action: "deny", protocol: "tcp", source: "10.0.0.0/24", destination: "192.168.1.10/32", port: 22, seq: 15 };
    expect(render("acl-entry", "ios", v)).toEqual(["ip access-list extended GUEST_IN", " 15 deny tcp 10.0.0.0 0.0.0.255 host 192.168.1.10 eq 22"]);
    expect(render("acl-entry", "eos", v)).toEqual(["ip access-list GUEST_IN", " 15 deny tcp 10.0.0.0/24 host 192.168.1.10 eq 22"]);
    expect(render("acl-entry", "nxos", { name: "A", action: "permit", protocol: "ip" })).toEqual(["ip access-list A", " permit ip any any"]);
    expect(() => render("acl-entry", "junos", v)).toThrow(/not available/);
  });
  it("refuses a port on a protocol that has none", () => {
    expect(() => validate(def("acl-entry"), { name: "A", protocol: "icmp", port: 80 })).toThrow(/tcp and udp only/);
    expect(() => validate(def("acl-entry"), { name: "A", source: "everyone" })).toThrow(/any/);
    expect(() => validate(def("acl-entry"), { name: "1bad", source: "any" })).toThrow(/start with a letter/);
  });
  it("bundles member interfaces into a port channel on each platform", () => {
    const v = { id: 2, members: "Gi0/1,Gi0/2", mode: "active" };
    expect(render("port-channel", "ios", v)).toEqual(["interface Gi0/1", " channel-group 2 mode active", "interface Gi0/2", " channel-group 2 mode active", "interface Port-channel2"]);
    expect(render("port-channel", "nxos", v).at(-1)).toBe("interface port-channel2");
    expect(render("port-channel", "junos", v)).toEqual(["set interfaces ae2 aggregated-ether-options lacp active", "set interfaces Gi0/1 gigether-options 802.3ad ae2", "set interfaces Gi0/2 gigether-options 802.3ad ae2"]);
    expect(() => validate(def("port-channel"), { id: 2, members: "Gi0/1, bad name" })).toThrow(/interface names/);
  });
  it("gives IOS the hardening steps that clear the hygiene findings, and only the ones chosen", () => {
    expect(render("hardening", "ios", { ssh2: true, http: false, enc: true, vty: false })).toEqual(["ip ssh version 2", "service password-encryption"]);
    expect(render("hardening", "ios", { ssh2: false, http: true, enc: false, vty: true })).toEqual(["no ip http server", "no ip http secure-server", "line vty 0 4", " transport input ssh"]);
    expect(() => validate(def("hardening"), { ssh2: false, http: false, enc: false, vty: false })).toThrow(/at least one/);
    expect(() => render("hardening", "eos", { ssh2: true })).toThrow(/not available/);
  });
  it("covers redundancy, relay and basic management on the platforms that have them", () => {
    expect(render("hsrp", "ios", { interface: "Gi0/1", group: 1, vip: "10.0.0.254", priority: 110 })).toEqual(["interface Gi0/1", " standby 1 ip 10.0.0.254", " standby 1 priority 110", " standby 1 preempt"]);
    expect(render("hsrp", "eos", { interface: "Vlan10", group: 1, vip: "10.0.0.254" })[1]).toBe(" vrrp 1 ipv4 10.0.0.254");
    expect(render("dhcp-relay", "nxos", { interface: "Vlan10", server: "10.0.0.5" })).toEqual(["interface Vlan10", " ip dhcp relay address 10.0.0.5"]);
    expect(render("dns", "junos", { server: "10.0.0.53" })).toEqual(["set system name-server 10.0.0.53"]);
    expect(render("hostname", "eos", { hostname: "edge-1", domain: "example.net" })).toEqual(["hostname edge-1", "dns domain example.net"]);
    expect(render("snmp-info", "junos", { location: "Frankfurt DC2" })).toEqual(['set snmp location "Frankfurt DC2"']);
    expect(() => validate(def("snmp-info"), {})).toThrow(/location, a contact/);
  });
  it("sets a loopback, an OSPF router id, an MTU and a VRF", () => {
    expect(render("loopback", "ios", { number: 1, address: "10.255.0.1/32" })).toEqual(["interface Loopback1", " ip address 10.255.0.1 255.255.255.255"]);
    expect(render("ospf-router-id", "junos", { routerid: "10.255.0.1" })).toEqual(["set routing-options router-id 10.255.0.1"]);
    expect(render("mtu", "eos", { interface: "Ethernet1", mtu: 9214 })).toEqual(["interface Ethernet1", " mtu 9214"]);
    expect(render("vrf", "ios", { name: "CUST_A", rd: "65100:10" })).toEqual(["vrf definition CUST_A", " rd 65100:10", " address-family ipv4"]);
    expect(() => validate(def("vrf"), { name: "CUST_A", rd: "not-an-rd" })).toThrow(/ASN:number/);
    expect(() => render("vrf", "eos", { name: "CUST_A", rd: "65100:10" })).toThrow(/under BGP/);
  });
  it("offers no way to enter a secret: no service has a password, key or community field", () => {
    // Switches such as "Encrypt stored passwords" are not secret entry; only fields a person types into are checked.
    for (const svc of CATALOG) for (const f of svc.fields.filter((x) => x.type !== "boolean")) expect(`${f.id} ${f.label}`, svc.id).not.toMatch(/pass|secret|community|key|token/i);
  });
});

describe("input is checked before it can reach a configuration line", () => {
  const bad = (id: string, v: Record<string, string | number | boolean>) => expect(() => validate(def(id), v)).toThrow(ProvisionError);
  it("rejects out-of-range and malformed values, naming the field", () => {
    bad("vlan", { id: 0, name: "X" });
    bad("vlan", { id: 4095, name: "X" });
    bad("vlan", { id: "ten", name: "X" });
    bad("routed-interface", { interface: "Gi0/1", address: "10.0.0.1" });
    bad("routed-interface", { interface: "Gi0/1", address: "10.0.0.300/24" });
    bad("routed-interface", { interface: "Gi0/1", address: "10.0.0.1/33" });
    bad("static-route", { prefix: "10.0.0.0/8", nexthop: "not-an-ip" });
    bad("bgp-neighbor", { local: 0, neighbor: "10.0.0.1", remote: 65200 });
    bad("trunk-port", { interface: "Gi0/1", vlans: "10,abc" });
    bad("trunk-port", { interface: "Gi0/1", vlans: "40-30" });
    expect(() => validate(def("vlan"), { id: 10 })).toThrow(/Name is required/);
  });
  it("cannot be used to smuggle a second command or a hidden character into the lines", () => {
    bad("vlan", { id: 10, name: "USERS\nreload" });
    bad("vlan", { id: 10, name: "USERS; reload" });
    bad("access-port", { interface: "Gi0/1\nreload", vlan: 10 });
    bad("access-port", { interface: "Gi0/1", vlan: 10, description: "ok\u0007bell" });
    bad("access-port", { interface: "Gi0/1 shutdown", vlan: 10 });
    bad("routed-interface", { interface: "Gi0/1", address: "10.0.0.1/24\nno shutdown" });
  });
  it("fills in documented defaults and drops optional empties", () => {
    expect(validate(def("ospf-interface"), { interface: "Gi0/1", area: "", process: "" })).toMatchObject({ area: 0, process: 1 });
    expect(validate(def("static-route"), { prefix: "10.0.0.0/8", nexthop: "10.1.1.1", distance: "" })).not.toHaveProperty("distance");
  });
});

describe("the provisioning API", () => {
  const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
  afterEach(() => { setProviders(null); setContext(undefined); });
  const req = (url: string, body?: unknown) => new Request(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { host: "localhost", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ctx = { params: Promise.resolve({}) };

  function boot() {
    process.env.TS_PROV_PW = "x";
    const file = join(mkdtempSync(join(tmpdir(), "ts-prov-")), "inv.yaml");
    writeFileSync(file, "credentials:\n  c: { username: admin, password: env:TS_PROV_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: 1, platform: ios }\n      - { name: J1, address: 127.0.0.2, port: 1, platform: junos }\n");
    const db = openDatabase(":memory:");
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "x", lastConnectAttempt: 0, llm: null, claude });
    setProviders([new StaticProvider(file)]);
    return db;
  }

  it("lists the services with their fields, and no rendering code", async () => {
    boot();
    const j = await (await catalogGet(req("/api/provisioning"), ctx)).json();
    expect(j.services.map((s: { id: string }) => s.id)).toContain("bgp-neighbor");
    expect(JSON.stringify(j)).not.toContain("render");
  });

  it("previews a service per device, flags a device that cannot take it, and refuses bad input with 400", async () => {
    boot();
    const ok = await renderPost(req("/api/provisioning/render", { scopeId: "static:s", service: "svi", values: { vlan: 10, address: "10.10.10.1/24" }, devices: ["R1", "J1"] }), ctx);
    const j = await ok.json();
    expect(j.devices[0]).toMatchObject({ device: "R1", commands: ["interface Vlan10", " ip address 10.10.10.1 255.255.255.0", " no shutdown"] });
    expect(j.devices[1]).toMatchObject({ device: "J1", error: expect.stringMatching(/not available for junos/) });
    const bad = await renderPost(req("/api/provisioning/render", { scopeId: "static:s", service: "svi", values: { vlan: 99999, address: "x" }, devices: ["R1"] }), ctx);
    expect(bad.status).toBe(400);
    expect((await renderPost(req("/api/provisioning/render", { scopeId: "static:s", service: "nope", values: {}, devices: ["R1"] }), ctx)).status).toBe(404);
    expect((await renderPost(req("/api/provisioning/render", { scopeId: "static:s", service: "vlan", values: { id: 5, name: "A" }, devices: ["ghost"] }), ctx)).status).toBe(404);
  });

  it("renders without changing anything: no change is filed", async () => {
    const db = boot();
    await renderPost(req("/api/provisioning/render", { scopeId: "static:s", service: "vlan", values: { id: 5, name: "A" }, devices: ["R1"] }), ctx);
    expect((db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(0);
    expect(renderFor(def("vlan"), { id: 5, name: "A" }, [{ label: "R1", platform: "ios" }])[0]).toHaveProperty("commands");
  });
});

describe("removing several changes at once", () => {
  const claude = { configured: false, model: null, configError: null, verification: "unverified" as const, checkedAt: null, error: null };
  afterEach(() => setContext(undefined));
  const make = (db: ReturnType<typeof openDatabase>, status: Parameters<typeof updateChange>[2]["status"]) => {
    const c = createChange(db, { scopeId: "s", environment: "lab", title: `t-${status}`, intent: "", source: "user", plan: { devices: [], warnings: [] } });
    return status === "proposed" || !status ? c : updateChange(db, c.id, { status });
  };

  it("removes what may go, skips and names what may not, and records it", async () => {
    const db = openDatabase(":memory:");
    setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "x", lastConnectAttempt: 0, llm: null, claude });
    const a = make(db, "verified");
    const b = make(db, "failed");
    const c = make(db, "deploying");
    const r = await removePost(new Request("http://localhost/api/changes/remove", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ ids: [a.id, b.id, c.id, "missing"] }) }), { params: Promise.resolve({}) });
    const j = await r.json();
    expect(j.removed).toBe(2);
    expect(j.skipped.map((s: { id: string }) => s.id).sort()).toEqual([c.id, "missing"].sort());
    expect(getChange(db, a.id)).toBeNull();
    expect(getChange(db, b.id)).toBeNull();
    expect(getChange(db, c.id)).not.toBeNull();
    expect(listAudit(db)[0].summary).toContain("Removed 2 changes");
  });
});
