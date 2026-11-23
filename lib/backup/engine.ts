import { nodeRef } from "../core/types";
import type { TopoNode } from "../cml/topology";
import { isNetworkBusy, readConfig } from "../changes/engine";
import { addAudit } from "../database/repo";
import { driverFor, keysFor } from "../diagnostics/platforms";
import { providerFor } from "../providers/registry";
import { getContext } from "../server/context";
import { type DriftEvent, recordBackup } from "./store";

export type BackupOutcome = { device: string; status: "new" | "changed" | "unchanged" | "failed" | "skipped"; reason?: string; backupId?: number };
export type BackupRun = { scopeId: string; title: string; at: string; devices: BackupOutcome[]; drift: DriftEvent[] };

export class BackupError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "BackupError";
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

/**
 * Reads the running configuration of every readable router and switch and stores each as a new version when it differs
 * from the last one. A difference that no Tiny Snitch change explains is recorded as drift. Read-only on the devices.
 */
export async function runBackups(scopeId: string, source: "scheduled" | "manual", actor = "system"): Promise<BackupRun> {
  const ctx = getContext();
  const { provider } = providerFor(scopeId);
  if (!provider) throw new BackupError("No inventory provides that network.", 404);
  if (isNetworkBusy(scopeId)) throw new BackupError("A change is being applied to this network; backups wait until it is done.");
  const topology = await provider.getTopology(scopeId, true);
  const transport = provider.transport(scopeId);
  const at = new Date().toISOString();
  const devices: BackupOutcome[] = [];
  const drift: DriftEvent[] = [];

  const work: TopoNode[] = [];
  for (const n of topology.nodes) {
    const can = provider.inspectable(n);
    const driver = driverFor(n.platform);
    if (!can.ok) devices.push({ device: n.label, status: "skipped", reason: can.reason });
    else if (!driver || !keysFor(n.kind, driver)) devices.push({ device: n.label, status: "skipped", reason: "Not a router or switch of a supported platform." });
    else work.push(n);
  }

  await mapLimit(work, 3, async (n) => {
    const r = await readConfig(transport, nodeRef(n));
    if (!r.ok) { devices.push({ device: n.label, status: "failed", reason: r.reason }); return; }
    const res = recordBackup(ctx.db, { scopeId, device: n.label, config: r.text, source });
    if (res.drift) drift.push(res.drift);
    devices.push({ device: n.label, backupId: res.backup.id, status: !res.changed ? "unchanged" : res.drift ? "changed" : "new" });
  });

  devices.sort((a, b) => a.device.localeCompare(b.device));
  const stored = devices.filter((d) => d.status === "new" || d.status === "changed").length;
  addAudit(ctx.db, { kind: "backup", actor, summary: `Backed up "${topology.lab.title}": ${devices.filter((d) => d.status !== "skipped" && d.status !== "failed").length} of ${devices.length} devices read, ${stored} new version(s), ${drift.length} drift event(s)`, data: { scopeId, source, failed: devices.filter((d) => d.status === "failed").map((d) => d.device), drift: drift.map((d) => d.device) } });
  return { scopeId, title: topology.lab.title, at, devices, drift };
}
