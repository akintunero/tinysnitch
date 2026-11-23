/**
 * Whether a device may be changed on a production network. Each device is checked on its own, and a person signs it off
 * as ready to go live; a change that touches a device that is not ready is refused when it is proposed and again when it
 * is applied. Nothing here talks to a device: it reads what Tiny Snitch already knows (the inventory, the stored backups
 * and drift), so the answer is quick and the same everywhere it is asked.
 */
import type { TopoNode } from "../cml/topology";
import { type DeviceTransport, type InventoryProvider, nodeRef } from "../core/types";
import type { Db } from "../database/db";
import { listDrift, latestBackup } from "../backup/store";
import { CLI } from "../transport/ssh";

/** A device's last stored configuration must be this recent for a change to be built on it. */
export const BASELINE_MAX_DAYS = 7;

export type ReadinessCheck = { id: "reachable" | "changeable" | "baseline" | "drift" | "signoff"; label: string; ok: boolean; detail: string };
export type SignOff = { by: string; at: string; note: string };
export type DeviceReadiness = { device: string; ready: boolean; checks: ReadinessCheck[]; signedOff: SignOff | null };

export function signOffOf(db: Db, scopeId: string, device: string): SignOff | null {
  const r = db.prepare("SELECT signed_by, signed_at, note FROM device_readiness WHERE scope_id = ? AND device = ?").get(scopeId, device) as { signed_by: string; signed_at: string; note: string } | undefined;
  return r ? { by: r.signed_by, at: r.signed_at, note: r.note } : null;
}

export function signOff(db: Db, scopeId: string, device: string, by: string, note = "", now = new Date()): SignOff {
  const at = now.toISOString();
  db.prepare("INSERT INTO device_readiness (scope_id, device, signed_by, signed_at, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope_id, device) DO UPDATE SET signed_by = excluded.signed_by, signed_at = excluded.signed_at, note = excluded.note")
    .run(scopeId, device, by, at, note.slice(0, 300));
  return { by, at, note: note.slice(0, 300) };
}

export function revokeSignOff(db: Db, scopeId: string, device: string): boolean {
  return Number(db.prepare("DELETE FROM device_readiness WHERE scope_id = ? AND device = ?").run(scopeId, device).changes) > 0;
}

/** The checks for one device. `transport` is only asked whether the device can be configured. */
export function checkDevice(db: Db, scopeId: string, node: TopoNode, provider: InventoryProvider, transport: DeviceTransport | undefined, now = new Date()): DeviceReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (id: ReadinessCheck["id"], label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

  const can = provider.inspectable(node);
  add("reachable", "Tiny Snitch can read it", can.ok, can.ok ? "It can be read now." : can.reason);

  const platform = node.platform ?? "ios";
  const support = transport?.pushSupport?.(nodeRef(node)) ?? (CLI[platform]?.configEnter ? { ok: true as const } : { ok: false as const, reason: `configuration changes are not supported for ${platform} devices over this connection` });
  add("changeable", "Tiny Snitch can configure it", support.ok, support.ok ? "Configuration changes are supported over this connection." : support.reason);

  const backup = latestBackup(db, scopeId, node.label);
  if (!backup) add("baseline", "Has a recent backup", false, "No configuration has been backed up yet. Run a backup first: it is what a rollback goes back to.");
  else {
    const days = (now.getTime() - Date.parse(backup.takenAt)) / 86_400_000;
    add("baseline", "Has a recent backup", days <= BASELINE_MAX_DAYS, days <= BASELINE_MAX_DAYS ? `Backed up ${backup.takenAt.slice(0, 16).replace("T", " ")} UTC.` : `The last backup is ${Math.floor(days)} days old (the limit is ${BASELINE_MAX_DAYS}). Run a backup first.`);
  }

  const drift = listDrift(db, scopeId, { limit: 500 }).filter((d) => d.device === node.label);
  add("drift", "No unreviewed changes made outside Tiny Snitch", drift.length === 0, drift.length === 0 ? "Its configuration matches what was last seen." : `${drift.length} unreviewed difference(s) from someone changing it directly. Look at them on Backups, and acknowledge them when they are understood.`);

  const so = signOffOf(db, scopeId, node.label);
  add("signoff", "A person has signed it off", !!so, so ? `Signed off by ${so.by} on ${so.at.slice(0, 10)}.` : "Nobody has said this device is ready to go live.");

  return { device: node.label, ready: checks.every((c) => c.ok), checks, signedOff: so };
}

export function checkDevices(db: Db, scopeId: string, nodes: TopoNode[], provider: InventoryProvider, transport?: DeviceTransport, now = new Date()): DeviceReadiness[] {
  return nodes.map((n) => checkDevice(db, scopeId, n, provider, transport, now));
}

/** The sentence a refused change carries: which devices, and the first thing wrong with each. */
export function describeNotReady(list: DeviceReadiness[]): string {
  const bad = list.filter((d) => !d.ready);
  const parts = bad.slice(0, 3).map((d) => `${d.device} (${d.checks.find((c) => !c.ok)!.detail.replace(/\.$/, "")})`);
  return `${bad.length} device${bad.length === 1 ? " is" : "s are"} not ready to go live: ${parts.join("; ")}${bad.length > 3 ? `; and ${bad.length - 3} more` : ""}. See Readiness on the Backups page.`;
}
