import { nodeRef } from "../core/types";
import { providerFor } from "../providers/registry";
import { getContext } from "../server/context";
import { driverFor } from "../diagnostics/platforms";
import { ChangeError, readConfig, rolloutOf } from "./engine";
import { OPENS_BLOCK } from "./config-diff";
import { modelFor } from "./models";
import { getChange } from "./store";

export type DevicePreview = {
  label: string;
  /** Could the device be read right now? When not, nothing else is known and `error` says why. */
  reachable: boolean;
  error: string | null;
  /** Lines that are not in the device's configuration yet, so applying them would change it. */
  wouldChange: string[];
  /** Lines the device already has. Applying them would do nothing. */
  alreadyInPlace: string[];
  /** A reason this would cut off Tiny Snitch's own access to the device. */
  cutoff: string | null;
  highRisk: string[];
  /** What the device itself said about the change (Junos "commit check"). Null where the platform has no such check. */
  deviceCheck: { ok: boolean; text: string } | null;
};

export type ChangePreview = { changeId: string; at: string; staged: boolean; canary: string[]; devices: DevicePreview[]; summary: string };

/**
 * Reads each device now and says what applying the change would and would not do, without changing anything. Where the
 * platform can check a change itself (Junos: load, commit check, discard), that result is included. This is a read of
 * the devices as they are at this moment; it is not a promise about when the change is later applied.
 */
export async function previewChange(id: string): Promise<ChangePreview> {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  const { provider } = providerFor(c.scopeId);
  if (!provider) throw new ChangeError("No inventory provides that network any more.", 404);
  const topology = await provider.getTopology(c.scopeId, true);
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const transport = provider.transport(c.scopeId);
  const ro = rolloutOf(c);

  const devices: DevicePreview[] = [];
  for (const d of c.plan.devices) {
    const base: DevicePreview = { label: d.label, reachable: false, error: null, wouldChange: [], alreadyInPlace: [], cutoff: null, highRisk: d.risks.filter((r) => r.risk === "high").map((r) => `${r.line} (${r.reason})`), deviceCheck: null };
    const node = nodes.get(d.deviceId);
    if (!node) { devices.push({ ...base, error: "The device is no longer in the network." }); continue; }
    const can = provider.inspectable(node);
    if (!can.ok) { devices.push({ ...base, error: can.reason }); continue; }
    const cfg = await readConfig(transport, nodeRef(node));
    if (!cfg.ok) { devices.push({ ...base, error: cfg.reason }); continue; }
    const model = modelFor(d.platform);
    const v = model.verify(d.commands, cfg.text);
    const missing = new Set(v.mismatches.map((m) => m.command));
    // Lines that only open a section (interface X, router ospf 1) are not worth listing as "already in place".
    const meaningful = d.commands.filter((l) => d.platform === "junos" || !OPENS_BLOCK.test(l.trim()));
    const check = driverFor(d.platform) ? await transport.dryRun?.(nodeRef(node), d.commands) : null;
    devices.push({
      ...base, reachable: true,
      wouldChange: d.commands.filter((l) => missing.has(l)),
      alreadyInPlace: meaningful.filter((l) => !missing.has(l)),
      cutoff: model.cutoff(cfg.text, d.platform, node.address, d.commands),
      deviceCheck: check ? { ok: check.ok, text: check.text.slice(0, 600) } : null,
    });
  }
  const unreachable = devices.filter((d) => !d.reachable).length;
  const noop = devices.filter((d) => d.reachable && d.wouldChange.length === 0).length;
  const blocked = devices.filter((d) => d.cutoff || (d.deviceCheck && !d.deviceCheck.ok)).length;
  const summary = [
    `${devices.length - unreachable} of ${devices.length} device(s) read.`,
    unreachable ? `${unreachable} could not be read, so nothing is known about them.` : "",
    noop ? `${noop} already have every line and would not change.` : "",
    blocked ? `${blocked} would be refused or lose contact.` : "",
    ro.staged ? `Staged: ${c.plan.devices.slice(0, ro.canary).map((d) => d.label).join(", ")} first${ro.pause ? ", then it pauses for you" : ""}.` : "",
  ].filter(Boolean).join(" ");
  return { changeId: id, at: new Date().toISOString(), staged: ro.staged, canary: c.plan.devices.slice(0, ro.canary).map((d) => d.label), devices, summary };
}
