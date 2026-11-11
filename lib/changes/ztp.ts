import { z } from "zod";
import { nodeRef, type Platform } from "../core/types";
import { driverFor } from "../diagnostics/platforms";
import { providerFor } from "../providers/registry";
import { ChangeError, proposeChange } from "./engine";
import type { Change } from "./store";

/**
 * Zero-touch provisioning: describe the intended baseline of each new device (name, interface addresses, OSPF) and
 * Tiny Snitch finds the devices that are up but still unconfigured and proposes that baseline for them. It is a
 * normal change: reviewed, approved, snapshotted, verified and reversible. Nothing is applied on its own.
 */
const cidr = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "use address/prefix, e.g. 10.0.0.1/24");
const ifName = z.string().regex(/^[A-Za-z][A-Za-z0-9/.-]{1,40}$/, "not a valid interface name");

export const ztpSpec = z.object({
  devices: z.array(z.object({
    device: z.string().min(1),
    hostname: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/, "not a valid hostname").optional(),
    interfaces: z.array(z.object({ name: ifName, address: cidr, description: z.string().max(80).regex(/^[^\r\n]*$/).optional(), ospfArea: z.union([z.number().int().min(0), z.string().regex(/^\d+\.\d+\.\d+\.\d+$/)]).optional() })).default([]),
    ospf: z.object({ processId: z.number().int().min(1).max(65535).default(1), routerId: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/).optional(), passive: z.array(ifName).default([]) }).optional(),
  })).min(1).max(20),
});
export type ZtpSpec = z.infer<typeof ztpSpec>;

const mask = (n: number) => [0, 1, 2, 3].map((i) => 256 - 2 ** (8 - Math.min(8, Math.max(0, n - i * 8)))).join(".");

/** The configuration lines for one device's baseline, in the dialect it speaks. */
export function renderBaseline(platform: Platform, d: ZtpSpec["devices"][number]): string[] {
  const out: string[] = [];
  const pid = d.ospf?.processId ?? 1;
  for (const i of d.interfaces) if (Number(i.address.split("/")[1]) > 32) throw new ChangeError(`${d.device}: ${i.address} is not a valid prefix length.`, 400);

  if (platform === "junos") {
    if (d.hostname) out.push(`set system host-name ${d.hostname}`);
    for (const i of d.interfaces) {
      if (i.description) out.push(`set interfaces ${i.name} description "${i.description.replace(/"/g, "")}"`);
      out.push(`set interfaces ${i.name} unit 0 family inet address ${i.address}`, `delete interfaces ${i.name} disable`);
      if (i.ospfArea !== undefined) out.push(`set protocols ospf area ${i.ospfArea} interface ${i.name}.0`);
    }
    if (d.ospf?.routerId) out.push(`set routing-options router-id ${d.ospf.routerId}`);
    for (const p of d.ospf?.passive ?? []) {
      const area = d.interfaces.find((i) => i.name === p)?.ospfArea;
      if (area === undefined) throw new ChangeError(`${d.device}: passive interface ${p} must also be listed under interfaces with an ospfArea.`, 400);
      out.push(`set protocols ospf area ${area} interface ${p}.0 passive`);
    }
    return out;
  }

  if (d.hostname) out.push(`hostname ${d.hostname}`);
  if (platform === "nxos" && d.ospf) out.push("feature ospf");
  if (platform === "nxos" && d.ospf?.passive.length) throw new ChangeError(`${d.device}: passive interfaces are not supported by provisioning for NX-OS yet; set them in a normal change.`, 400);
  for (const i of d.interfaces) {
    const [addr, len] = i.address.split("/");
    out.push(`interface ${i.name}`);
    if (i.description) out.push(`description ${i.description}`);
    if (platform === "eos" || platform === "nxos") out.push("no switchport", `ip address ${addr}/${len}`);
    else out.push(`ip address ${addr} ${mask(Number(len))}`);
    out.push("no shutdown");
    if (i.ospfArea !== undefined) out.push(platform === "eos" ? `ip ospf area ${i.ospfArea}` : platform === "nxos" ? `ip router ospf ${pid} area ${i.ospfArea}` : `ip ospf ${pid} area ${i.ospfArea}`);
  }
  if (d.ospf) {
    out.push(`router ospf ${pid}`);
    if (d.ospf.routerId) out.push(`router-id ${d.ospf.routerId}`);
    for (const p of d.ospf.passive) out.push(`passive-interface ${p}`);
  }
  return out;
}

const DEFAULT_NAME = /^(router|switch|ios|iosv|iosvl2|csr\d*v?|vios|nxos|eos|localhost|device|vsrx|vmx|vqfx|junos|switch|n\dk)\d*$/i;

export type Candidate = { device: string; unconfigured: boolean; reason: string };

/** Which devices that can be read look factory-fresh: a default hostname and no interface with an address. */
export async function findUnconfigured(scopeId: string): Promise<Candidate[]> {
  const { provider } = providerFor(scopeId);
  if (!provider) throw new ChangeError("No inventory provides that network.", 404);
  const topology = await provider.getTopology(scopeId, true);
  const transport = provider.transport(scopeId);
  const out: Candidate[] = [];
  for (const n of topology.nodes) {
    const can = provider.inspectable(n);
    const drv = driverFor(n.platform);
    if (!can.ok) { out.push({ device: n.label, unconfigured: false, reason: can.reason }); continue; }
    if (!drv || (n.kind !== "router" && n.kind !== "l3switch")) { out.push({ device: n.label, unconfigured: false, reason: "Not a router or layer-3 switch Tiny Snitch can provision." }); continue; }
    const r = await transport.run(nodeRef(n), drv.commands.config ?? "show running-config");
    if (!r.ok) { out.push({ device: n.label, unconfigured: false, reason: `Could not read it: ${r.text.split("\n")[0].slice(0, 120)}` }); continue; }
    const cfg = drv.parse.config(r.text);
    const addressed = [...cfg.interfaces.values()].filter((i) => i.ip).length;
    const fresh = (!cfg.hostname || DEFAULT_NAME.test(cfg.hostname)) && addressed === 0;
    out.push({ device: n.label, unconfigured: fresh, reason: fresh ? `Default hostname${cfg.hostname ? ` "${cfg.hostname}"` : ""} and no interface has an address.` : `Already configured (hostname ${cfg.hostname ?? "unknown"}, ${addressed} addressed interface(s)).` });
  }
  return out;
}

export async function proposeProvisioning(scopeId: string, specIn: unknown, title?: string): Promise<Change> {
  const parsed = ztpSpec.safeParse(specIn);
  if (!parsed.success) throw new ChangeError(`The provisioning plan is not valid: ${parsed.error.issues[0].path.join(".") || "plan"} ${parsed.error.issues[0].message}.`, 400);
  const { provider } = providerFor(scopeId);
  if (!provider) throw new ChangeError("No inventory provides that network.", 404);
  const topology = await provider.getTopology(scopeId);
  const devices = parsed.data.devices.map((d) => {
    const node = topology.nodes.find((n) => n.label === d.device);
    if (!node) throw new ChangeError(`There is no device named "${d.device}" in this network.`, 400);
    return { device: d.device, commands: renderBaseline(node.platform ?? "ios", d) };
  });
  return proposeChange({ scopeId, title: title ?? `Provision ${devices.length} new device(s)`, intent: "Baseline configuration for new devices (zero-touch provisioning).", source: "ztp", devices });
}
