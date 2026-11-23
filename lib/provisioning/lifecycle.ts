/**
 * What it takes to change or take away a service that was provisioned earlier.
 *
 * Every service says which of its fields make it *that* service (its identity). Change a non-identity field, such as a
 * description or an MTU, and the new lines simply overwrite the old ones. Change an identity field, such as the VLAN id
 * or the interface, and it is a different thing: the old one is removed and the new one provisioned, in one change.
 *
 * Removal is written out per service and per platform, never guessed by negating lines, because "undo" is not the same as
 * "no <line>": taking a VLAN away is not the same as renaming it, and an interface should be left shut, not wiped.
 * A service whose effect cannot be undone safely (the hostname, hardening steps) has no removal and says why.
 */
import type { Platform } from "../core/types";
import { type Clean, type ServiceDef, ProvisionError, cidr, renderFor, str as s } from "./catalog";

/** Fields that make a service *that* service. Changing one removes the old and provisions the new. Empty: overwrite in place. */
export const IDENTITY: Record<string, string[]> = {
  vlan: ["id"], "access-port": ["interface"], "trunk-port": ["interface"], "routed-interface": ["interface"], svi: ["vlan"],
  "static-route": ["prefix", "nexthop"], "ospf-interface": ["interface"], "bgp-neighbor": ["neighbor", "local"], ntp: ["server"], syslog: ["host"], dns: ["server"],
  loopback: ["number"], mtu: ["interface"], "acl-entry": ["name", "action", "protocol", "source", "destination", "port", "seq"], "acl-apply": ["interface", "name", "direction"],
  "dhcp-relay": ["interface", "server"], "port-channel": ["id"], "snmp-info": [], hsrp: ["interface", "group"], vrf: ["name"], "ospf-router-id": [], hostname: [], "interface-state": ["interface"], hardening: [],
};

const desc = (v: Clean, line: string) => (v.description ? [line] : []);
const jd = (name: string) => `${name}`;

type Remover = (p: Platform, v: Clean) => string[];

/** Lines that undo what the service rendered. Services missing here cannot be removed automatically. */
const REMOVERS: Record<string, Remover> = {
  vlan: (p, v) => (p === "junos" ? [`delete vlans ${s(v, "name").replace(/ /g, "_")}`] : [`no vlan ${s(v, "id")}`]),
  "access-port": (p, v) => {
    const i = s(v, "interface");
    if (p === "junos") return [`delete interfaces ${i} unit 0 family ethernet-switching`, ...desc(v, `delete interfaces ${i} description`)];
    return [`interface ${i}`, " no switchport access vlan", " no switchport mode access", ...desc(v, " no description")];
  },
  "trunk-port": (p, v) => {
    const i = s(v, "interface");
    if (p === "junos") return [`delete interfaces ${i} unit 0 family ethernet-switching`, ...desc(v, `delete interfaces ${i} description`)];
    return [`interface ${i}`, " no switchport trunk allowed vlan", " no switchport mode trunk", ...desc(v, " no description")];
  },
  "routed-interface": (p, v) => {
    const i = s(v, "interface");
    if (p === "junos") return [`delete interfaces ${i} unit 0 family inet address ${s(v, "address")}`, ...desc(v, `delete interfaces ${i} description`)];
    return [`interface ${i}`, ...desc(v, " no description"), " no ip address", " shutdown"];
  },
  svi: (p, v) => (p === "junos" ? [] : [`no interface Vlan${s(v, "vlan")}`]),
  "static-route": (p, v) => {
    const a = cidr(s(v, "prefix"));
    const d = v.distance ? ` ${s(v, "distance")}` : "";
    if (p === "junos") return [`delete routing-options static route ${a.ip}/${a.len} next-hop ${s(v, "nexthop")}`];
    return [p === "ios" ? `no ip route ${a.ip} ${a.mask} ${s(v, "nexthop")}${d}` : `no ip route ${a.ip}/${a.len} ${s(v, "nexthop")}${d}`];
  },
  "ospf-interface": (p, v) => {
    const i = s(v, "interface");
    if (p === "junos") return [`delete protocols ospf area ${s(v, "area")} interface ${i}`];
    if (p === "ios") return [`interface ${i}`, ` no ip ospf ${s(v, "process")} area ${s(v, "area")}`];
    if (p === "eos") return [`interface ${i}`, ` no ip ospf area ${s(v, "area")}`];
    return [`interface ${i}`, ` no ip router ospf ${s(v, "process")} area ${s(v, "area")}`];
  },
  "bgp-neighbor": (p, v) => {
    if (p === "junos") return [`delete protocols bgp group ${jd(s(v, "group").replace(/ /g, "_"))} neighbor ${s(v, "neighbor")}`];
    return [`router bgp ${s(v, "local")}`, p === "ios" ? ` no neighbor ${s(v, "neighbor")} remote-as ${s(v, "remote")}` : ` no neighbor ${s(v, "neighbor")}`];
  },
  ntp: (p, v) => (p === "junos" ? [`delete system ntp server ${s(v, "server")}`] : [`no ntp server ${s(v, "server")}`]),
  syslog: (p, v) => (p === "junos" ? [`delete system syslog host ${s(v, "host")}`] : p === "nxos" ? [`no logging server ${s(v, "host")}`] : [`no logging host ${s(v, "host")}`]),
  dns: (p, v) => (p === "junos" ? [`delete system name-server ${s(v, "server")}`] : [`no ip name-server ${s(v, "server")}`]),
  loopback: (p, v) => (p === "junos" ? [`delete interfaces lo0 unit ${s(v, "number")}`] : [`no interface Loopback${s(v, "number")}`]),
  mtu: (p, v) => (p === "junos" ? [`delete interfaces ${s(v, "interface")} mtu`] : [`interface ${s(v, "interface")}`, " no mtu"]),
  "acl-apply": (p, v) => (p === "junos" ? [] : [`interface ${s(v, "interface")}`, ` no ip access-group ${s(v, "name")} ${s(v, "direction")}`]),
  "acl-entry": (p, v) => {
    if (p === "junos") return [];
    const aclAddr = (k: string) => { const x = s(v, k); if (x === "any") return "any"; const a = cidr(x); return a.len === 32 ? `host ${a.ip}` : p === "ios" ? `${a.ip} ${a.wildcard}` : `${a.ip}/${a.len}`; };
    const entry = v.seq ? `${s(v, "seq")}` : `${s(v, "action")} ${s(v, "protocol")} ${aclAddr("source")} ${aclAddr("destination")}${v.port ? ` eq ${s(v, "port")}` : ""}`;
    return [p === "ios" ? `ip access-list extended ${s(v, "name")}` : `ip access-list ${s(v, "name")}`, ` no ${entry}`];
  },
  "dhcp-relay": (p, v) => (p === "junos" ? [] : [`interface ${s(v, "interface")}`, p === "nxos" ? ` no ip dhcp relay address ${s(v, "server")}` : ` no ip helper-address ${s(v, "server")}`]),
  "port-channel": (p, v) => {
    const id = s(v, "id");
    const members = s(v, "members").split(",");
    if (p === "junos") return [...members.map((m) => `delete interfaces ${m} gigether-options 802.3ad`), `delete interfaces ae${id}`];
    return [...members.flatMap((m) => [`interface ${m}`, ` no channel-group ${id}`]), `no interface ${p === "nxos" ? "port-channel" : "Port-channel"}${id}`];
  },
  "snmp-info": (p, v) => {
    if (p === "junos") return [...(v.location ? ["delete snmp location"] : []), ...(v.contact ? ["delete snmp contact"] : [])];
    return [...(v.location ? ["no snmp-server location"] : []), ...(v.contact ? ["no snmp-server contact"] : [])];
  },
  hsrp: (p, v) => {
    const i = s(v, "interface");
    if (p === "eos") return [`interface ${i}`, ` no vrrp ${s(v, "group")} ipv4 ${s(v, "vip")}`, ` no vrrp ${s(v, "group")} priority-level ${s(v, "priority")}`];
    return [`interface ${i}`, ` no standby ${s(v, "group")} preempt`, ` no standby ${s(v, "group")} priority ${s(v, "priority")}`, ` no standby ${s(v, "group")} ip ${s(v, "vip")}`];
  },
};

/** Why a service cannot be taken away automatically, for the ones that cannot. */
const NOT_REMOVABLE: Record<string, string> = {
  "ospf-router-id": "A router id cannot be unset safely: the device would pick another by itself. Set it to the value you want instead.",
  vrf: "Removing a VRF deletes every interface and route inside it. Do that by hand, with a change you have read.",
  hardening: "Hardening steps are not undone automatically; weakening a device should be a deliberate change.",
  hostname: "A hostname is not undone. Set the name you want.",
  "interface-state": "An interface's state is not undone. Set the state you want.",
};

export const isRemovable = (def: ServiceDef): boolean => def.id in REMOVERS;
export const notRemovableReason = (id: string): string | null => NOT_REMOVABLE[id] ?? (id in REMOVERS ? null : "This service has no automatic removal.");

/** Lines that take the service away on one platform. Throws when there is nothing safe to send. */
export function removeLines(def: ServiceDef, platform: Platform, values: Clean): string[] {
  const rm = REMOVERS[def.id];
  if (!rm) throw new ProvisionError(notRemovableReason(def.id) ?? "This service cannot be removed automatically.");
  if (!def.platforms.includes(platform)) throw new ProvisionError(`${def.title} is not available for ${platform} devices.`);
  const lines = rm(platform, values);
  if (!lines.length) throw new ProvisionError(`${def.title} has no automatic removal for ${platform} devices.`);
  return lines;
}

export const identityOf = (def: ServiceDef): string[] => IDENTITY[def.id] ?? [];

/** True when a change from `before` to `after` swaps the thing itself, so the old one must go and the new one be provisioned. */
export function identityChanged(def: ServiceDef, before: Clean, after: Clean): boolean {
  return identityOf(def).some((k) => String(before[k] ?? "") !== String(after[k] ?? ""));
}

export type DeviceLines = { device: string; platform: Platform; commands: string[]; remove: number; add: number } | { device: string; platform: Platform; error: string };

const sameValues = (a: Clean, b: Clean) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * The lines for each device that turn what was provisioned into what is wanted: removal first, then the new rendering.
 * A device dropped from the service gets the removal only; a device added gets the rendering only.
 */
export function planModify(def: ServiceDef, before: { values: Clean; devices: string[] }, after: { values: Clean; devices: string[] }, platformOf: (device: string) => Platform): DeviceLines[] {
  if (sameValues(before.values, after.values) && [...before.devices].sort().join("|") === [...after.devices].sort().join("|")) throw new ProvisionError("Nothing is different from what was provisioned.");
  const swap = identityChanged(def, before.values, after.values);
  const out: DeviceLines[] = [];
  for (const device of new Set([...before.devices, ...after.devices])) {
    const platform = platformOf(device);
    const was = before.devices.includes(device);
    const will = after.devices.includes(device);
    try {
      const remove = was && (!will || swap) ? removeLines(def, platform, before.values) : [];
      const add = will ? renderOne(def, platform, after.values) : [];
      out.push({ device, platform, commands: [...remove, ...add], remove: remove.length, add: add.length });
    } catch (e) {
      out.push({ device, platform, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Lines that take the service away from every device it is on. */
export function planDecommission(def: ServiceDef, current: { values: Clean; devices: string[] }, platformOf: (device: string) => Platform): DeviceLines[] {
  return current.devices.map((device) => {
    const platform = platformOf(device);
    try {
      const commands = removeLines(def, platform, current.values);
      return { device, platform, commands, remove: commands.length, add: 0 };
    } catch (e) {
      return { device, platform, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function renderOne(def: ServiceDef, platform: Platform, values: Clean): string[] {
  const r = renderFor(def, values, [{ label: "x", platform }])[0];
  if ("error" in r) throw new ProvisionError(r.error);
  return r.commands;
}

/** The (device, interface) pairs a service touches, so a failing link can be traced to the services it affects. */
export function touches(def: ServiceDef, values: Clean, devices: string[]): { device: string; interface: string | null }[] {
  const ifaces: string[] = [];
  for (const f of def.fields) {
    if (f.type === "interface" && values[f.id]) ifaces.push(String(values[f.id]));
    if (f.type === "interfaces" && values[f.id]) ifaces.push(...String(values[f.id]).split(","));
  }
  return devices.flatMap((device): { device: string; interface: string | null }[] => (ifaces.length ? ifaces.map((interfaceName) => ({ device, interface: interfaceName })) : [{ device, interface: null }]));
}
