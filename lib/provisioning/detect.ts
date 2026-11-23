/**
 * What a device's configuration says it is running: routing protocols, addressing, time, logging and so on. This reads the
 * configuration text only. It says what is configured, not that it works (diagnostics does that), and it knows nothing about
 * whether Tiny Snitch provisioned it. IOS-style syntax, which IOS, EOS and NX-OS largely share; Junos set-format is not read.
 */
export type Running = { id: string; label: string; detail: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function detectRunning(config: string): Running[] {
  const lines = config.split(/\r?\n/);
  const top = (re: RegExp) => lines.filter((l) => re.test(l));
  const out: Running[] = [];
  const add = (id: string, label: string, detail: string) => out.push({ id, label, detail });

  const bgp = /^router bgp (\S+)/m.exec(config);
  if (bgp) {
    const peers = new Set(lines.map((l) => /^\s*neighbor (\S+) remote-as (\S+)/.exec(l)).filter(Boolean).map((m) => m![1]));
    add("bgp", "BGP", `AS ${bgp[1]}, ${plural(peers.size, "neighbour")}`);
  }
  const ospf = [...config.matchAll(/^router ospf (\S+)/gm)].map((m) => m[1]);
  if (ospf.length) {
    const areas = new Set([...config.matchAll(/^\s*(?:network \S+ \S+ area|ip ospf \S+ area) (\S+)/gm)].map((m) => m[1]));
    add("ospf", "OSPF", `process ${ospf.join(", ")}${areas.size ? `, ${plural(areas.size, "area")}` : ""}`);
  }
  const isis = /^router isis(?: (\S+))?/m.exec(config);
  if (isis) add("isis", "IS-IS", isis[1] ? `tag ${isis[1]}` : "default instance");
  const routes = top(/^ip route \S+/).length;
  if (routes) add("static", "Static routes", plural(routes, "route"));
  const vrfs = [...config.matchAll(/^(?:vrf definition|ip vrf|vrf instance|vrf context) (\S+)/gm)].map((m) => m[1]);
  if (vrfs.length) add("vrf", "VRFs", vrfs.join(", "));
  const vlans = top(/^vlan \d[\d,-]*\s*$/).length;
  if (vlans) add("vlan", "VLANs", plural(vlans, "VLAN"));
  const svis = top(/^interface Vlan\d+/i).length;
  if (svis) add("svi", "VLAN interfaces", plural(svis, "interface"));
  const pc = top(/^interface Port-channel\d+/i).length;
  if (pc) add("lag", "Port channels", plural(pc, "bundle"));
  const lo = top(/^interface Loopback\d+/i).length;
  if (lo) add("loopback", "Loopbacks", plural(lo, "interface"));
  const fhrp = lines.filter((l) => /^\s*(standby \d+ ip|vrrp \d+ (?:ip|address))/.test(l)).length;
  if (fhrp) add("fhrp", "Gateway redundancy", plural(fhrp, "group"));
  const dhcp = lines.filter((l) => /^\s*ip helper-address /.test(l)).length;
  if (dhcp) add("dhcp-relay", "DHCP relay", plural(dhcp, "interface"));
  const ntp = top(/^ntp server /).map((l) => l.split(/\s+/)[2]);
  if (ntp.length) add("ntp", "NTP", ntp.join(", "));
  const logs = top(/^logging (?:host )?\d+\.\d+\.\d+\.\d+/).map((l) => /(\d+\.\d+\.\d+\.\d+)/.exec(l)![1]);
  if (logs.length) add("syslog", "Syslog", logs.join(", "));
  const dns = top(/^ip name-server /).flatMap((l) => l.split(/\s+/).slice(2));
  if (dns.length) add("dns", "DNS", dns.join(", "));
  if (/^snmp-server (location|contact|community)/m.test(config)) add("snmp", "SNMP", [/^snmp-server location/m.test(config) && "location", /^snmp-server contact/m.test(config) && "contact", /^snmp-server community/m.test(config) && "community"].filter(Boolean).join(", "));
  const acls = new Set([...config.matchAll(/^ip(?:v6)? access-list (?:extended |standard )?(\S+)/gm)].map((m) => m[1]));
  for (const m of config.matchAll(/^access-list (\d+) /gm)) acls.add(m[1]);
  if (acls.size) add("acl", "Access lists", plural(acls.size, "list"));
  if (/^ip ssh version 2/m.test(config)) add("ssh", "SSH", "version 2");
  return out;
}
