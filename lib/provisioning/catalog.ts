/**
 * A catalogue of services an engineer can provision from a form: the intent (a VLAN, a routed interface, a BGP
 * neighbour) goes in, and the configuration lines for each device's platform come out. The lines are not applied here.
 * They become an ordinary change, so they pass the same validation, approval, snapshot, verification and rollback as
 * anything typed by hand.
 */
import type { Platform } from "../core/types";

export type FieldType = "text" | "ipv4" | "cidr" | "prefix" | "interface" | "interfaces" | "name" | "hostname" | "domain" | "vlan" | "vlans" | "asn" | "int" | "select" | "boolean";

export type Field = {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
};

export type Values = Record<string, string | number | boolean>;
export type Clean = Record<string, string | number | boolean>;

export type ServiceDef = {
  id: string;
  group: "Switching" | "Routing" | "Security" | "Redundancy" | "Management";
  title: string;
  summary: string;
  fields: Field[];
  /** Rules that involve more than one field, run after each field has passed its own check. Throw a ProvisionError to refuse. */
  check?: (v: Clean) => void;
  /** Platforms this service has a rendering for. A device on another platform is shown as unsupported, with the reason. */
  platforms: Platform[];
  render: (platform: Platform, v: Clean) => string[];
};

export class ProvisionError extends Error {}

// ---- validation: every value ends up inside a configuration line, so nothing but plain printable text gets through ----

const PLAIN = /^[\x20-\x7e]*$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,63}$/;
const IFACE = /^[A-Za-z][A-Za-z0-9/._:-]{0,40}$/;

function octets(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}
const maskOf = (len: number) => {
  const bits = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return [24, 16, 8, 0].map((sh) => (bits >>> sh) & 255).join(".");
};
const wildcardOf = (len: number) => maskOf(len).split(".").map((o) => 255 - Number(o)).join(".");

/** "10,20,30-40" becomes "10,20,30-40" after checking each id, or throws. */
function vlanList(s: string): string {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 64) throw new ProvisionError("List between 1 and 64 VLANs or ranges, such as 10,20,30-40.");
  for (const p of parts) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(p);
    const a = m ? Number(m[1]) : 0;
    const b = m?.[2] ? Number(m[2]) : a;
    if (!m || a < 1 || b > 4094 || b < a) throw new ProvisionError(`"${p}" is not a VLAN id or range between 1 and 4094.`);
  }
  return parts.join(",");
}

export function validate(def: ServiceDef, input: Values): Clean {
  const out: Clean = {};
  for (const f of def.fields) {
    const raw = input[f.id];
    const empty = raw === undefined || raw === null || raw === "";
    if (empty) {
      if (f.default !== undefined) out[f.id] = f.default;
      else if (f.required) throw new ProvisionError(`${f.label} is required.`);
      continue;
    }
    const fail = (why: string): never => { throw new ProvisionError(`${f.label}: ${why}`); };
    if (f.type === "boolean") { out[f.id] = raw === true || raw === "true"; continue; }
    if (f.type === "int" || f.type === "vlan" || f.type === "asn") {
      const n = Number(raw);
      const [lo, hi] = f.type === "vlan" ? [1, 4094] : f.type === "asn" ? [1, 4294967295] : [f.min ?? 0, f.max ?? 1_000_000];
      if (!Number.isInteger(n) || n < lo || n > hi) fail(`enter a whole number from ${lo} to ${hi}.`);
      out[f.id] = n;
      continue;
    }
    const s = String(raw).trim();
    if (!PLAIN.test(s) || s.length > 200) fail("only plain printable characters are allowed.");
    if (f.type === "ipv4") { if (!octets(s)) fail("enter an IPv4 address such as 10.0.0.1."); }
    else if (f.type === "cidr") {
      const [ip, len] = s.split("/");
      if (!octets(ip ?? "") || !/^\d{1,2}$/.test(len ?? "") || Number(len) > 32) fail("enter an address with prefix length, such as 10.0.0.1/24.");
    } else if (f.type === "prefix") {
      if (s !== "any") {
        const [ip, len] = s.split("/");
        if (!octets(ip ?? "") || !/^\d{1,2}$/.test(len ?? "") || Number(len) > 32) fail('enter "any" or an address with prefix length, such as 10.0.0.0/24.');
      }
    } else if (f.type === "interface") { if (!IFACE.test(s)) fail("enter an interface name such as GigabitEthernet0/1 or ge-0/0/1."); }
    else if (f.type === "interfaces") {
      const list = s.split(",").map((x) => x.trim()).filter(Boolean);
      if (!list.length || list.length > 16 || !list.every((x) => IFACE.test(x))) fail("list 1 to 16 interface names separated by commas.");
      out[f.id] = list.join(",");
      continue;
    } else if (f.type === "name") { if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s)) fail("start with a letter; letters, numbers, - and _ only, up to 32 characters."); }
    else if (f.type === "hostname") { if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(s)) fail("letters, numbers and - only, up to 63 characters."); }
    else if (f.type === "domain") { if (!/^(?=.{3,100}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s)) fail("enter a domain such as example.net."); }
    else if (f.type === "vlans") { out[f.id] = vlanList(s); continue; }
    else if (f.type === "select") { if (!f.options?.some((o) => o.value === s)) fail("choose one of the listed options."); }
    else if (f.type === "text") { if (!WORD.test(s)) fail("use letters, numbers, spaces and . _ : @ / - only, up to 64 characters."); }
    out[f.id] = s;
  }
  def.check?.(out);
  return out;
}

export const cidr = (v: string) => { const [ip, len] = v.split("/"); return { ip, len: Number(len), mask: maskOf(Number(len)), wildcard: wildcardOf(Number(len)) }; };
const s = (v: Clean, k: string) => String(v[k] ?? "");
export const str = s;
const desc = (v: Clean, pre: string) => (v.description ? [`${pre}description ${s(v, "description")}`] : []);

function unsupported(def: string, p: Platform): never {
  throw new ProvisionError(`${def} is not available for ${p} devices.`);
}

/** An ACL address: "any", or a prefix written the way the platform expects (IOS wants a wildcard mask, or "host"). */
function aclAddr(p: Platform, v: string): string {
  if (v === "any") return "any";
  const a = cidr(v);
  if (a.len === 32) return `host ${a.ip}`;
  return p === "ios" ? `${a.ip} ${a.wildcard}` : `${a.ip}/${a.len}`;
}

// ---- the services ----

const IFACE_FIELD: Field = { id: "interface", label: "Interface", type: "interface", required: true, placeholder: "GigabitEthernet0/1" };
const DESC_FIELD: Field = { id: "description", label: "Description", type: "text", help: "Optional." };

export const CATALOG: ServiceDef[] = [
  {
    id: "vlan", group: "Switching", title: "VLAN", summary: "Create a VLAN with a name.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "id", label: "VLAN id", type: "vlan", required: true }, { id: "name", label: "Name", type: "text", required: true, placeholder: "USERS" }],
    render: (p, v) => {
      const name = s(v, "name").replace(/ /g, "_");
      if (p === "junos") return [`set vlans ${name} vlan-id ${s(v, "id")}`];
      if (p === "unknown") return unsupported("VLAN", p);
      return [`vlan ${s(v, "id")}`, ` name ${name}`];
    },
  },
  {
    id: "access-port", group: "Switching", title: "Access port", summary: "Put an interface in one VLAN as an untagged port.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, { id: "vlan", label: "VLAN id", type: "vlan", required: true }, DESC_FIELD],
    render: (p, v) => {
      const i = s(v, "interface");
      if (p === "junos") return [`set interfaces ${i} unit 0 family ethernet-switching interface-mode access`, `set interfaces ${i} unit 0 family ethernet-switching vlan members ${s(v, "vlan")}`, ...(v.description ? [`set interfaces ${i} description "${s(v, "description")}"`] : [])];
      if (p === "unknown") return unsupported("Access port", p);
      return [`interface ${i}`, ...desc(v, " "), " switchport mode access", ` switchport access vlan ${s(v, "vlan")}`];
    },
  },
  {
    id: "trunk-port", group: "Switching", title: "Trunk port", summary: "Carry several VLANs, tagged, on one interface.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, { id: "vlans", label: "Allowed VLANs", type: "vlans", required: true, placeholder: "10,20,30-40" }, DESC_FIELD],
    render: (p, v) => {
      const i = s(v, "interface");
      if (p === "junos") return [`set interfaces ${i} unit 0 family ethernet-switching interface-mode trunk`, ...s(v, "vlans").split(",").map((x) => `set interfaces ${i} unit 0 family ethernet-switching vlan members ${x}`), ...(v.description ? [`set interfaces ${i} description "${s(v, "description")}"`] : [])];
      if (p === "unknown") return unsupported("Trunk port", p);
      return [`interface ${i}`, ...desc(v, " "), ...(p === "ios" ? [" switchport trunk encapsulation dot1q"] : []), " switchport mode trunk", ` switchport trunk allowed vlan ${s(v, "vlans")}`];
    },
  },
  {
    id: "routed-interface", group: "Routing", title: "Routed interface", summary: "Give an interface an IPv4 address and bring it up.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, { id: "address", label: "Address", type: "cidr", required: true, placeholder: "10.0.12.1/30" }, DESC_FIELD],
    render: (p, v) => {
      const i = s(v, "interface");
      const a = cidr(s(v, "address"));
      if (p === "junos") return [`set interfaces ${i} unit 0 family inet address ${s(v, "address")}`, ...(v.description ? [`set interfaces ${i} description "${s(v, "description")}"`] : [])];
      if (p === "unknown") return unsupported("Routed interface", p);
      if (p === "ios") return [`interface ${i}`, ...desc(v, " "), ` ip address ${a.ip} ${a.mask}`, " no shutdown"];
      return [`interface ${i}`, ...desc(v, " "), " no switchport", ` ip address ${a.ip}/${a.len}`, " no shutdown"];
    },
  },
  {
    id: "svi", group: "Routing", title: "VLAN interface (SVI)", summary: "Route for a VLAN: an IPv4 address on VLAN N.", platforms: ["ios", "eos", "nxos"],
    fields: [{ id: "vlan", label: "VLAN id", type: "vlan", required: true }, { id: "address", label: "Address", type: "cidr", required: true, placeholder: "10.10.10.1/24" }, DESC_FIELD],
    render: (p, v) => {
      const a = cidr(s(v, "address"));
      if (p === "ios") return [`interface Vlan${s(v, "vlan")}`, ...desc(v, " "), ` ip address ${a.ip} ${a.mask}`, " no shutdown"];
      if (p === "eos" || p === "nxos") return [`interface Vlan${s(v, "vlan")}`, ...desc(v, " "), ` ip address ${a.ip}/${a.len}`, " no shutdown"];
      return unsupported("VLAN interface", p);
    },
  },
  {
    id: "static-route", group: "Routing", title: "Static route", summary: "Send a prefix to a next hop.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [
      { id: "prefix", label: "Destination", type: "cidr", required: true, placeholder: "192.168.50.0/24" },
      { id: "nexthop", label: "Next hop", type: "ipv4", required: true, placeholder: "10.0.12.2" },
      { id: "distance", label: "Administrative distance", type: "int", min: 1, max: 255, help: "Optional. Leave empty for the default." },
    ],
    render: (p, v) => {
      const a = cidr(s(v, "prefix"));
      const d = v.distance ? ` ${s(v, "distance")}` : "";
      if (p === "ios") return [`ip route ${a.ip} ${a.mask} ${s(v, "nexthop")}${d}`];
      if (p === "eos" || p === "nxos") return [`ip route ${a.ip}/${a.len} ${s(v, "nexthop")}${d}`];
      if (p === "junos") return [`set routing-options static route ${a.ip}/${a.len} next-hop ${s(v, "nexthop")}${v.distance ? ` preference ${s(v, "distance")}` : ""}`];
      return unsupported("Static route", p);
    },
  },
  {
    id: "ospf-interface", group: "Routing", title: "OSPF on an interface", summary: "Run OSPF on an interface in an area.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, { id: "area", label: "Area", type: "int", required: true, min: 0, max: 4294967295, default: 0 }, { id: "process", label: "Process id", type: "int", min: 1, max: 65535, default: 1, help: "Not used on Junos." }],
    render: (p, v) => {
      const i = s(v, "interface");
      if (p === "ios") return [`interface ${i}`, ` ip ospf ${s(v, "process")} area ${s(v, "area")}`];
      if (p === "eos") return [`interface ${i}`, ` ip ospf area ${s(v, "area")}`];
      if (p === "nxos") return [`interface ${i}`, ` ip router ospf ${s(v, "process")} area ${s(v, "area")}`];
      if (p === "junos") return [`set protocols ospf area ${s(v, "area")} interface ${i}`];
      return unsupported("OSPF", p);
    },
  },
  {
    id: "bgp-neighbor", group: "Routing", title: "BGP neighbour", summary: "Add an IPv4 BGP neighbour.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [
      { id: "local", label: "Local AS", type: "asn", required: true },
      { id: "neighbor", label: "Neighbour address", type: "ipv4", required: true },
      { id: "remote", label: "Remote AS", type: "asn", required: true },
      { id: "group", label: "Group name", type: "text", default: "EXTERNAL", help: "Junos only." },
    ],
    render: (p, v) => {
      if (p === "ios") return [`router bgp ${s(v, "local")}`, ` neighbor ${s(v, "neighbor")} remote-as ${s(v, "remote")}`, " address-family ipv4", `  neighbor ${s(v, "neighbor")} activate`];
      if (p === "eos") return [`router bgp ${s(v, "local")}`, ` neighbor ${s(v, "neighbor")} remote-as ${s(v, "remote")}`];
      if (p === "nxos") return [`router bgp ${s(v, "local")}`, ` neighbor ${s(v, "neighbor")}`, `  remote-as ${s(v, "remote")}`, "  address-family ipv4 unicast"];
      if (p === "junos") return [`set routing-options autonomous-system ${s(v, "local")}`, `set protocols bgp group ${s(v, "group").replace(/ /g, "_")} type external`, `set protocols bgp group ${s(v, "group").replace(/ /g, "_")} neighbor ${s(v, "neighbor")} peer-as ${s(v, "remote")}`];
      return unsupported("BGP neighbour", p);
    },
  },
  {
    id: "ntp", group: "Management", title: "NTP server", summary: "Point the device at a time server.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "server", label: "Server", type: "ipv4", required: true }],
    render: (p, v) => (p === "junos" ? [`set system ntp server ${s(v, "server")}`] : p === "unknown" ? unsupported("NTP", p) : [`ntp server ${s(v, "server")}`]),
  },
  {
    id: "syslog", group: "Management", title: "Syslog server", summary: "Send logs to a collector.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "host", label: "Collector", type: "ipv4", required: true }],
    render: (p, v) => (p === "junos" ? [`set system syslog host ${s(v, "host")} any notice`] : p === "nxos" ? [`logging server ${s(v, "host")}`] : p === "unknown" ? unsupported("Syslog", p) : [`logging host ${s(v, "host")}`]),
  },
  {
    id: "interface-state", group: "Management", title: "Interface description and state", summary: "Describe an interface, and bring it up or shut it down.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, DESC_FIELD, { id: "up", label: "Administratively up", type: "boolean", default: true }],
    render: (p, v) => {
      const i = s(v, "interface");
      if (p === "junos") return [...(v.description ? [`set interfaces ${i} description "${s(v, "description")}"`] : []), v.up ? `delete interfaces ${i} disable` : `set interfaces ${i} disable`];
      if (p === "unknown") return unsupported("Interface state", p);
      return [`interface ${i}`, ...desc(v, " "), v.up ? " no shutdown" : " shutdown"];
    },
  },
  {
    id: "loopback", group: "Routing", title: "Loopback interface", summary: "Create a loopback with an address, for router ids and management.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "number", label: "Loopback number", type: "int", required: true, min: 0, max: 65535, default: 0 }, { id: "address", label: "Address", type: "cidr", required: true, placeholder: "10.255.0.1/32" }, DESC_FIELD],
    render: (p, v) => {
      const a = cidr(s(v, "address"));
      if (p === "junos") return [`set interfaces lo0 unit ${s(v, "number")} family inet address ${s(v, "address")}`];
      if (p === "unknown") return unsupported("Loopback", p);
      return [`interface Loopback${s(v, "number")}`, ...desc(v, " "), p === "ios" ? ` ip address ${a.ip} ${a.mask}` : ` ip address ${a.ip}/${a.len}`];
    },
  },
  {
    id: "ospf-router-id", group: "Routing", title: "OSPF router id", summary: "Set the OSPF router id, normally a loopback address.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "routerid", label: "Router id", type: "ipv4", required: true }, { id: "process", label: "Process id", type: "int", min: 1, max: 65535, default: 1, help: "Not used on Junos." }],
    render: (p, v) => (p === "junos" ? [`set routing-options router-id ${s(v, "routerid")}`] : p === "unknown" ? unsupported("OSPF router id", p) : [`router ospf ${s(v, "process")}`, ` router-id ${s(v, "routerid")}`]),
  },
  {
    id: "vrf", group: "Routing", title: "VRF", summary: "Create a VRF, optionally with a route distinguisher.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "name", label: "Name", type: "name", required: true, placeholder: "CUSTOMER_A" }, { id: "rd", label: "Route distinguisher", type: "text", placeholder: "65100:10", help: "Optional, as ASN:number." }],
    check: (v) => { if (v.rd && !/^\d{1,10}:\d{1,10}$/.test(String(v.rd))) throw new ProvisionError("Route distinguisher: use the form ASN:number, such as 65100:10."); },
    render: (p, v) => {
      const n = s(v, "name");
      if (p === "ios") return [`vrf definition ${n}`, ...(v.rd ? [` rd ${s(v, "rd")}`] : []), " address-family ipv4"];
      if (p === "eos") {
        if (v.rd) throw new ProvisionError("Arista sets the route distinguisher under BGP, not on the VRF. Leave it empty here.");
        return [`vrf instance ${n}`, `ip routing vrf ${n}`];
      }
      if (p === "nxos") return [`vrf context ${n}`, ...(v.rd ? [` rd ${s(v, "rd")}`] : [])];
      if (p === "junos") return [`set routing-instances ${n} instance-type vrf`, ...(v.rd ? [`set routing-instances ${n} route-distinguisher ${s(v, "rd")}`] : [])];
      return unsupported("VRF", p);
    },
  },
  {
    id: "port-channel", group: "Switching", title: "Port channel (LACP)", summary: "Bundle interfaces into one logical link.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [
      { id: "id", label: "Channel number", type: "int", required: true, min: 1, max: 128 },
      { id: "members", label: "Member interfaces", type: "interfaces", required: true, placeholder: "GigabitEthernet0/1, GigabitEthernet0/2" },
      { id: "mode", label: "LACP mode", type: "select", default: "active", options: [{ value: "active", label: "active" }, { value: "passive", label: "passive" }] },
      DESC_FIELD,
    ],
    render: (p, v) => {
      const members = s(v, "members").split(",");
      const id = s(v, "id");
      if (p === "junos") return [`set interfaces ae${id} aggregated-ether-options lacp ${s(v, "mode")}`, ...members.map((m) => `set interfaces ${m} gigether-options 802.3ad ae${id}`), ...(v.description ? [`set interfaces ae${id} description "${s(v, "description")}"`] : [])];
      if (p === "unknown") return unsupported("Port channel", p);
      return [...members.flatMap((m) => [`interface ${m}`, ` channel-group ${id} mode ${s(v, "mode")}`]), `interface ${p === "nxos" ? "port-channel" : "Port-channel"}${id}`, ...desc(v, " ")];
    },
  },
  {
    id: "mtu", group: "Switching", title: "Interface MTU", summary: "Set the MTU of an interface.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [IFACE_FIELD, { id: "mtu", label: "MTU", type: "int", required: true, min: 576, max: 9216, default: 1500 }],
    render: (p, v) => (p === "junos" ? [`set interfaces ${s(v, "interface")} mtu ${s(v, "mtu")}`] : p === "unknown" ? unsupported("MTU", p) : [`interface ${s(v, "interface")}`, ` mtu ${s(v, "mtu")}`]),
  },
  {
    id: "acl-entry", group: "Security", title: "Access list entry", summary: "Add a permit or deny line to a named ACL. The list is created if it does not exist.", platforms: ["ios", "eos", "nxos"],
    fields: [
      { id: "name", label: "ACL name", type: "name", required: true, placeholder: "GUEST_IN" },
      { id: "action", label: "Action", type: "select", default: "permit", options: [{ value: "permit", label: "permit" }, { value: "deny", label: "deny" }] },
      { id: "protocol", label: "Protocol", type: "select", default: "ip", options: [{ value: "ip", label: "ip (any)" }, { value: "tcp", label: "tcp" }, { value: "udp", label: "udp" }, { value: "icmp", label: "icmp" }] },
      { id: "source", label: "Source", type: "prefix", default: "any", placeholder: "any or 10.0.0.0/24" },
      { id: "destination", label: "Destination", type: "prefix", default: "any", placeholder: "any or 192.168.1.10/32" },
      { id: "port", label: "Destination port", type: "int", min: 1, max: 65535, help: "TCP and UDP only. Leave empty for any port." },
      { id: "seq", label: "Sequence number", type: "int", min: 1, max: 4294967294, help: "Optional. Without one the entry goes at the end." },
    ],
    check: (v) => { if (v.port && v.protocol !== "tcp" && v.protocol !== "udp") throw new ProvisionError("Destination port: it applies to tcp and udp only."); },
    render: (p, v) => {
      if (p === "unknown" || p === "junos") return unsupported("Access list entry", p);
      const addr = (k: string) => aclAddr(p, s(v, k));
      const line = `${v.seq ? `${s(v, "seq")} ` : ""}${s(v, "action")} ${s(v, "protocol")} ${addr("source")} ${addr("destination")}${v.port ? ` eq ${s(v, "port")}` : ""}`;
      return [p === "ios" ? `ip access-list extended ${s(v, "name")}` : `ip access-list ${s(v, "name")}`, ` ${line}`];
    },
  },
  {
    id: "acl-apply", group: "Security", title: "Apply an access list", summary: "Attach a named ACL to an interface, inbound or outbound.", platforms: ["ios", "eos", "nxos"],
    fields: [IFACE_FIELD, { id: "name", label: "ACL name", type: "name", required: true }, { id: "direction", label: "Direction", type: "select", default: "in", options: [{ value: "in", label: "in" }, { value: "out", label: "out" }] }],
    render: (p, v) => (p === "unknown" || p === "junos" ? unsupported("Apply an access list", p) : [`interface ${s(v, "interface")}`, ` ip access-group ${s(v, "name")} ${s(v, "direction")}`]),
  },
  {
    id: "hardening", group: "Security", title: "Management hardening", summary: "SSH version 2, no HTTP server, encrypted stored passwords, SSH-only VTY lines. These are the fixes for the hygiene findings in Diagnostics.", platforms: ["ios"],
    fields: [
      { id: "ssh2", label: "SSH version 2", type: "boolean", default: true },
      { id: "http", label: "Disable the HTTP server", type: "boolean", default: true },
      { id: "enc", label: "Encrypt stored passwords", type: "boolean", default: true },
      { id: "vty", label: "VTY lines accept SSH only (cuts off Telnet)", type: "boolean", default: false, help: "Check that you reach the device over SSH first. The preview warns if the change would cut off Tiny Snitch's own access." },
    ],
    check: (v) => { if (!v.ssh2 && !v.http && !v.enc && !v.vty) throw new ProvisionError("Choose at least one hardening step."); },
    render: (p, v) => {
      if (p !== "ios") return unsupported("Management hardening", p);
      return [...(v.ssh2 ? ["ip ssh version 2"] : []), ...(v.http ? ["no ip http server", "no ip http secure-server"] : []), ...(v.enc ? ["service password-encryption"] : []), ...(v.vty ? ["line vty 0 4", " transport input ssh"] : [])];
    },
  },
  {
    id: "hsrp", group: "Redundancy", title: "Gateway redundancy (HSRP / VRRP)", summary: "A shared virtual gateway address on an interface.", platforms: ["ios", "eos"],
    fields: [IFACE_FIELD, { id: "group", label: "Group", type: "int", required: true, min: 0, max: 255, default: 1 }, { id: "vip", label: "Virtual address", type: "ipv4", required: true }, { id: "priority", label: "Priority", type: "int", min: 1, max: 254, default: 100 }],
    render: (p, v) => {
      if (p === "ios") return [`interface ${s(v, "interface")}`, ` standby ${s(v, "group")} ip ${s(v, "vip")}`, ` standby ${s(v, "group")} priority ${s(v, "priority")}`, ` standby ${s(v, "group")} preempt`];
      if (p === "eos") return [`interface ${s(v, "interface")}`, ` vrrp ${s(v, "group")} ipv4 ${s(v, "vip")}`, ` vrrp ${s(v, "group")} priority-level ${s(v, "priority")}`];
      return unsupported("Gateway redundancy", p);
    },
  },
  {
    id: "dhcp-relay", group: "Management", title: "DHCP relay", summary: "Forward DHCP requests on an interface to a server.", platforms: ["ios", "eos", "nxos"],
    fields: [IFACE_FIELD, { id: "server", label: "DHCP server", type: "ipv4", required: true }],
    render: (p, v) => (p === "nxos" ? [`interface ${s(v, "interface")}`, ` ip dhcp relay address ${s(v, "server")}`] : p === "ios" || p === "eos" ? [`interface ${s(v, "interface")}`, ` ip helper-address ${s(v, "server")}`] : unsupported("DHCP relay", p)),
  },
  {
    id: "dns", group: "Management", title: "DNS server", summary: "Point the device at a name server.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "server", label: "Server", type: "ipv4", required: true }],
    render: (p, v) => (p === "junos" ? [`set system name-server ${s(v, "server")}`] : p === "unknown" ? unsupported("DNS", p) : [`ip name-server ${s(v, "server")}`]),
  },
  {
    id: "hostname", group: "Management", title: "Hostname and domain", summary: "Set the device name and, optionally, its domain.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "hostname", label: "Hostname", type: "hostname", required: true }, { id: "domain", label: "Domain", type: "domain", placeholder: "example.net", help: "Optional." }],
    render: (p, v) => {
      if (p === "junos") return [`set system host-name ${s(v, "hostname")}`, ...(v.domain ? [`set system domain-name ${s(v, "domain")}`] : [])];
      if (p === "unknown") return unsupported("Hostname", p);
      return [`hostname ${s(v, "hostname")}`, ...(v.domain ? [p === "eos" ? `dns domain ${s(v, "domain")}` : `ip domain-name ${s(v, "domain")}`] : [])];
    },
  },
  {
    id: "snmp-info", group: "Management", title: "SNMP location and contact", summary: "Set who to contact and where the device is. No community strings or credentials.", platforms: ["ios", "eos", "nxos", "junos"],
    fields: [{ id: "location", label: "Location", type: "text", placeholder: "Frankfurt DC2 rack 14" }, { id: "contact", label: "Contact", type: "text", placeholder: "noc@example.net" }],
    check: (v) => { if (!v.location && !v.contact) throw new ProvisionError("Give a location, a contact, or both."); },
    render: (p, v) => {
      if (p === "junos") return [...(v.location ? [`set snmp location "${s(v, "location")}"`] : []), ...(v.contact ? [`set snmp contact "${s(v, "contact")}"`] : [])];
      if (p === "unknown") return unsupported("SNMP", p);
      return [...(v.location ? [`snmp-server location ${s(v, "location")}`] : []), ...(v.contact ? [`snmp-server contact ${s(v, "contact")}`] : [])];
    },
  },
];

export const serviceById = (id: string): ServiceDef | undefined => CATALOG.find((d) => d.id === id);

/** What the page needs to draw a form: everything except the rendering function. */
export const catalogForClient = () => CATALOG.map(({ render: _r, ...rest }) => rest);

export type Rendered = { device: string; platform: Platform; commands: string[] } | { device: string; platform: Platform; error: string };

export function renderFor(def: ServiceDef, values: Clean, devices: { label: string; platform: Platform }[]): Rendered[] {
  return devices.map((d) => {
    if (!def.platforms.includes(d.platform)) return { device: d.label, platform: d.platform, error: `${def.title} is not available for ${d.platform} devices.` };
    try {
      return { device: d.label, platform: d.platform, commands: def.render(d.platform, values) };
    } catch (e) {
      return { device: d.label, platform: d.platform, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
