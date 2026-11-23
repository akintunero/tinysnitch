/**
 * Service instances: a provisioned service remembered as a thing of its own.
 *
 * Filing a service from the form creates an instance and an ordinary change for it. The instance then follows that change:
 * it is `pending` while a person reviews and applies it, `active` once the change is verified on the devices, and so on.
 * It can be modified or decommissioned later, each through a change of its own, so approval, snapshot, read-back verification
 * and rollback apply to every step of its life, not only the first.
 *
 * The instance never touches a device itself. It decides which lines a change should carry, files that change, and reads the
 * change's outcome back. When the outcome is not "verified", what is recorded as applied does not move.
 */
import { randomUUID } from "node:crypto";
import { emitEvent } from "../api/webhooks";
import { ChangeError, proposeChange } from "../changes/engine";
import { type Change, getChange } from "../changes/store";
import type { Platform } from "../core/types";
import type { Db } from "../database/db";
import { addAudit } from "../database/repo";
import { currentActor } from "../security/actor";
import { getContext } from "../server/context";
import { fetchTopology } from "../server/topology";
import { type Clean, ProvisionError, type ServiceDef, renderFor, serviceById, validate } from "./catalog";
import { type DeviceLines, notRemovableReason, planDecommission, planModify, touches } from "./lifecycle";

export type ServiceStatus = "pending" | "active" | "failed" | "inactive" | "retired";
export type ServiceOp = "provision" | "modify" | "decommission";
export type Placement = { values: Clean; devices: string[] };

export type ServiceInstance = {
  id: string; scopeId: string; serviceId: string; title: string; name: string; status: ServiceStatus;
  values: Clean; devices: string[]; applied: Placement | null;
  pending: { changeId: string; op: ServiceOp } | null;
  touches: { device: string; interface: string | null }[];
  removable: boolean; notRemovable: string | null;
  createdBy: string | null; createdAt: string; updatedAt: string; retiredAt: string | null;
};
export type HistoryEntry = { changeId: string; op: ServiceOp; createdAt: string; title: string | null; changeStatus: string | null };

export class ServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Row = {
  id: string; scope_id: string; service_id: string; name: string; status: ServiceStatus; values_json: string; devices_json: string;
  applied_values_json: string | null; applied_devices_json: string | null; pending_change_id: string | null; pending_op: ServiceOp | null;
  touches_json: string; created_by: string | null; created_at: string; updated_at: string; retired_at: string | null;
};

const fromRow = (r: Row): ServiceInstance => {
  const def = serviceById(r.service_id);
  return {
    id: r.id, scopeId: r.scope_id, serviceId: r.service_id, title: def?.title ?? r.service_id, name: r.name, status: r.status,
    values: JSON.parse(r.values_json) as Clean, devices: JSON.parse(r.devices_json) as string[],
    applied: r.applied_values_json ? { values: JSON.parse(r.applied_values_json) as Clean, devices: JSON.parse(r.applied_devices_json ?? "[]") as string[] } : null,
    pending: r.pending_change_id && r.pending_op ? { changeId: r.pending_change_id, op: r.pending_op } : null,
    touches: JSON.parse(r.touches_json) as { device: string; interface: string | null }[],
    removable: def ? notRemovableReason(def.id) === null : false, notRemovable: def ? notRemovableReason(def.id) : "This service is no longer in the catalogue.",
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, retiredAt: r.retired_at,
  };
};

const rowOf = (db: Db, id: string): Row | undefined => db.prepare("SELECT * FROM service_instances WHERE id = ?").get(id) as Row | undefined;

function emit(db: Db, type: "service.created" | "service.active" | "service.failed" | "service.inactive" | "service.retired", i: ServiceInstance): void {
  emitEvent(db, type, { serviceId: i.id, scopeId: i.scopeId, name: i.name, type: i.serviceId, status: i.status, devices: i.devices });
}

// ---- reading, and following the change ----------------------------------------------------------------------------------------------------

const OPEN: Change["status"][] = ["proposed", "approved", "deploying", "paused", "rolling_back"];

/**
 * Brings an instance in line with the outcome of its open change. Called whenever instances are read and on every scheduler tick, so
 * a change finished by someone else, or by the scheduler, is reflected without anyone opening the page. A change that no longer
 * exists (it was removed from the list) counts as withdrawn.
 */
export function reconcile(db: Db, inst: ServiceInstance): ServiceInstance {
  if (!inst.pending) return inst;
  const c = getChange(db, inst.pending.changeId);
  const st: Change["status"] = c?.status ?? "rejected";
  if (OPEN.includes(st)) return inst;
  const now = new Date().toISOString();
  const op = inst.pending.op;
  let status: ServiceStatus;
  let values = inst.values, devices = inst.devices;
  let applied = inst.applied;
  let retiredAt: string | null = inst.retiredAt;
  if (st === "verified") {
    if (op === "decommission") { status = "retired"; applied = null; retiredAt = now; }
    else { status = "active"; applied = { values: inst.values, devices: inst.devices }; }
  } else if (st === "failed" || st === "rollback_failed") {
    status = "failed";
  } else if (applied) {
    // rejected or rolled back: what was on the devices before is still there, so that is what the service is again
    status = "active"; values = applied.values; devices = applied.devices;
  } else {
    status = "inactive";
  }
  db.prepare("UPDATE service_instances SET status = ?, values_json = ?, devices_json = ?, applied_values_json = ?, applied_devices_json = ?, pending_change_id = NULL, pending_op = NULL, updated_at = ?, retired_at = ? WHERE id = ?")
    .run(status, JSON.stringify(values), JSON.stringify(devices), applied ? JSON.stringify(applied.values) : null, applied ? JSON.stringify(applied.devices) : null, now, retiredAt, inst.id);
  const next = fromRow(rowOf(db, inst.id)!);
  addAudit(db, { kind: "configuration", actor: "system", summary: `Service "${next.name}" is now ${status} (${op}, change ${st.replace("_", " ")})`, data: { serviceId: next.id, op, change: inst.pending.changeId } });
  if (status === "active") emit(db, "service.active", next);
  else if (status === "failed") emit(db, "service.failed", next);
  else if (status === "inactive") emit(db, "service.inactive", next);
  else if (status === "retired") emit(db, "service.retired", next);
  return next;
}

export function listServices(db: Db, scopeId: string | null, opts: { includeRetired?: boolean } = {}): ServiceInstance[] {
  const rows = (scopeId
    ? db.prepare("SELECT * FROM service_instances WHERE scope_id = ? ORDER BY created_at DESC").all(scopeId)
    : db.prepare("SELECT * FROM service_instances ORDER BY created_at DESC").all()) as Row[];
  const all = rows.map((r) => reconcile(db, fromRow(r)));
  return opts.includeRetired ? all : all.filter((i) => i.status !== "retired");
}

export function getService(db: Db, id: string): (ServiceInstance & { history: HistoryEntry[] }) | null {
  const r = rowOf(db, id);
  if (!r) return null;
  const inst = reconcile(db, fromRow(r));
  const history = (db.prepare("SELECT change_id, op, created_at FROM service_history WHERE service_id = ? ORDER BY id DESC").all(id) as { change_id: string; op: ServiceOp; created_at: string }[])
    .map((h) => { const c = getChange(db, h.change_id); return { changeId: h.change_id, op: h.op, createdAt: h.created_at, title: c?.title ?? null, changeStatus: c?.status ?? null }; });
  return { ...inst, history };
}

/** Called on a timer: finished changes move their services along even when nobody is looking. */
export function reconcileAll(db: Db): void {
  for (const r of db.prepare("SELECT * FROM service_instances WHERE pending_change_id IS NOT NULL").all() as Row[]) reconcile(db, fromRow(r));
}

// ---- acting ---------------------------------------------------------------------------------------------------------------------------------------

async function platformsOf(scopeId: string): Promise<(device: string) => Platform> {
  const topology = await fetchTopology(scopeId);
  return (device) => {
    const n = topology.nodes.find((x) => x.label === device);
    if (!n) throw new ServiceError(`${device} is not a device of this network.`, 404);
    return n.platform ?? "ios";
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:@/#()-]{1,79}$/;

function problems(lines: DeviceLines[]): string | null {
  const bad = lines.filter((l): l is Extract<DeviceLines, { error: string }> => "error" in l);
  return bad.length ? bad.map((b) => `${b.device}: ${b.error}`).join(" ") : null;
}

async function file(scopeId: string, inst: { name: string }, op: ServiceOp, lines: DeviceLines[], title: string): Promise<Change> {
  const devices = lines.filter((l): l is Extract<DeviceLines, { commands: string[] }> => "commands" in l && l.commands.length > 0).map((l) => ({ device: l.device, commands: l.commands }));
  if (!devices.length) throw new ServiceError("There is nothing to send to any device.");
  try {
    return await proposeChange({ scopeId, title: title.slice(0, 120), intent: `Service "${inst.name}": ${op}.`, source: "user", devices });
  } catch (e) {
    if (e instanceof ChangeError) throw new ServiceError(e.message, e.status);
    throw e;
  }
}

function openOrThrow(inst: ServiceInstance): void {
  if (inst.pending) throw new ServiceError("A change for this service is still open. Finish or reject it first.", 409);
}

function link(db: Db, id: string, change: Change, op: ServiceOp, patch: { values?: Clean; devices?: string[]; name?: string; touches?: unknown }): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE service_instances SET status = 'pending', pending_change_id = ?, pending_op = ?, values_json = COALESCE(?, values_json), devices_json = COALESCE(?, devices_json), name = COALESCE(?, name), touches_json = COALESCE(?, touches_json), updated_at = ? WHERE id = ?")
    .run(change.id, op, patch.values ? JSON.stringify(patch.values) : null, patch.devices ? JSON.stringify(patch.devices) : null, patch.name ?? null, patch.touches ? JSON.stringify(patch.touches) : null, now, id);
  db.prepare("INSERT INTO service_history (service_id, change_id, op, created_at) VALUES (?, ?, ?, ?)").run(id, change.id, op, now);
}

const clean = (def: ServiceDef, values: Record<string, string | number | boolean>): Clean => {
  try { return validate(def, values); } catch (e) { if (e instanceof ProvisionError) throw new ServiceError(e.message); throw e; }
};

/** Files a new service: validates it, renders it for each device, proposes the change and remembers the instance. */
export async function createService(input: { scopeId: string; serviceId: string; name: string; values: Record<string, string | number | boolean>; devices: string[] }): Promise<{ service: ServiceInstance; change: Change }> {
  const { db } = getContext();
  const def = serviceById(input.serviceId);
  if (!def) throw new ServiceError("No such service.", 404);
  const name = input.name.trim();
  if (!NAME.test(name)) throw new ServiceError("Give the service a name of 2 to 80 characters: letters, numbers, spaces and . _ : @ / # ( ) -");
  if (!input.devices.length || input.devices.length > 20) throw new ServiceError("Choose between 1 and 20 devices.");
  if (listServices(db, input.scopeId).some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new ServiceError(`A service called "${name}" already exists in this network.`, 409);
  const values = clean(def, input.values);
  const platformOf = await platformsOf(input.scopeId);
  const devices = [...new Set(input.devices)];
  const rendered = renderFor(def, values, devices.map((label) => ({ label, platform: platformOf(label) })));
  const bad = rendered.filter((r): r is Extract<typeof r, { error: string }> => "error" in r);
  if (bad.length) throw new ServiceError(bad.map((b) => `${b.device}: ${b.error}`).join(" "));
  const lines: DeviceLines[] = rendered.map((r) => ({ device: r.device, platform: r.platform, commands: (r as { commands: string[] }).commands, remove: 0, add: (r as { commands: string[] }).commands.length }));
  const change = await file(input.scopeId, { name }, "provision", lines, `Provision ${name}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO service_instances (id, scope_id, service_id, name, status, values_json, devices_json, pending_change_id, pending_op, touches_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 'provision', ?, ?, ?, ?)")
    .run(id, input.scopeId, def.id, name, JSON.stringify(values), JSON.stringify(devices), change.id, JSON.stringify(touches(def, values, devices)), currentActor()?.username ?? null, now, now);
  db.prepare("INSERT INTO service_history (service_id, change_id, op, created_at) VALUES (?, ?, 'provision', ?)").run(id, change.id, now);
  const service = fromRow(rowOf(db, id)!);
  addAudit(db, { kind: "configuration", actor: "user", summary: `Provisioned service "${name}" (${def.title}) on ${devices.join(", ")}`, data: { serviceId: id, changeId: change.id } });
  emit(db, "service.created", service);
  return { service, change };
}

export type Plan = { operation: ServiceOp; devices: DeviceLines[] };

/** Change what a service is, or where it is. `dryRun` only shows the lines. A rename alone changes nothing on any device. */
export async function modifyService(id: string, patch: { name?: string; values?: Record<string, string | number | boolean>; devices?: string[] }, opts: { dryRun?: boolean } = {}): Promise<{ plan: Plan | null; change: Change | null; service: ServiceInstance }> {
  const { db } = getContext();
  const found = getService(db, id);
  if (!found) throw new ServiceError("No such service.", 404);
  const inst: ServiceInstance = found;
  const def = serviceById(inst.serviceId);
  if (!def) throw new ServiceError("This service is no longer in the catalogue.", 409);
  openOrThrow(inst);
  if (inst.status !== "active") throw new ServiceError(`A ${inst.status} service cannot be modified. ${inst.status === "failed" || inst.status === "inactive" ? "Retry it, or decommission or forget it." : ""}`.trim(), 409);
  const name = patch.name?.trim();
  if (name !== undefined && !NAME.test(name)) throw new ServiceError("Give the service a name of 2 to 80 characters: letters, numbers, spaces and . _ : @ / # ( ) -");
  if (name && name.toLowerCase() !== inst.name.toLowerCase() && listServices(db, inst.scopeId).some((s) => s.id !== inst.id && s.name.toLowerCase() === name.toLowerCase())) throw new ServiceError(`A service called "${name}" already exists in this network.`, 409);
  const before = inst.applied ?? { values: inst.values, devices: inst.devices };
  const values = patch.values ? clean(def, { ...before.values, ...patch.values }) : before.values;
  const devices = patch.devices ? [...new Set(patch.devices)] : before.devices;
  if (!devices.length) throw new ServiceError("A service needs at least one device. Decommission it to take it away.");
  const unchanged = JSON.stringify(Object.entries(values).sort()) === JSON.stringify(Object.entries(before.values).sort()) && [...devices].sort().join("|") === [...before.devices].sort().join("|");
  if (unchanged) {
    if (name && name !== inst.name) {
      if (!opts.dryRun) { db.prepare("UPDATE service_instances SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id); addAudit(db, { kind: "configuration", actor: "user", summary: `Renamed service "${inst.name}" to "${name}"`, data: { serviceId: id } }); }
      return { plan: null, change: null, service: getService(db, id)! };
    }
    throw new ServiceError("Nothing is different from what was provisioned.");
  }
  const platformOf = await platformsOf(inst.scopeId);
  let lines: DeviceLines[];
  try { lines = planModify(def, before, { values, devices }, platformOf); } catch (e) { if (e instanceof ProvisionError) throw new ServiceError(e.message); throw e; }
  const bad = problems(lines);
  if (bad) throw new ServiceError(bad);
  const plan: Plan = { operation: "modify", devices: lines };
  if (opts.dryRun) return { plan, change: null, service: inst };
  const change = await file(inst.scopeId, inst, "modify", lines, `Change ${name ?? inst.name}`);
  link(db, id, change, "modify", { values, devices, name, touches: touches(def, values, devices) });
  addAudit(db, { kind: "configuration", actor: "user", summary: `Changed service "${name ?? inst.name}"`, data: { serviceId: id, changeId: change.id } });
  return { plan, change, service: getService(db, id)! };
}

/** Take a service away from the devices through a change. */
export async function decommissionService(id: string, opts: { dryRun?: boolean } = {}): Promise<{ plan: Plan; change: Change | null; service: ServiceInstance }> {
  const { db } = getContext();
  const inst = getService(db, id);
  if (!inst) throw new ServiceError("No such service.", 404);
  const def = serviceById(inst.serviceId);
  if (!def) throw new ServiceError("This service is no longer in the catalogue.", 409);
  openOrThrow(inst);
  if (inst.status === "retired") throw new ServiceError("This service is already retired.", 409);
  if (inst.status === "inactive") throw new ServiceError("This service was never applied, so there is nothing to remove. Forget it, or retry it.", 409);
  const reason = notRemovableReason(def.id);
  if (reason) throw new ServiceError(reason, 409);
  const current = inst.applied ?? { values: inst.values, devices: inst.devices };
  const platformOf = await platformsOf(inst.scopeId);
  const lines = planDecommission(def, current, platformOf);
  const bad = problems(lines);
  if (bad) throw new ServiceError(bad);
  const plan: Plan = { operation: "decommission", devices: lines };
  if (opts.dryRun) return { plan, change: null, service: inst };
  const change = await file(inst.scopeId, inst, "decommission", lines, `Remove ${inst.name}`);
  link(db, id, change, "decommission", {});
  addAudit(db, { kind: "configuration", actor: "user", summary: `Decommissioning service "${inst.name}"`, data: { serviceId: id, changeId: change.id } });
  return { plan, change, service: getService(db, id)! };
}

/** Try again after a failure, or after a change that was rejected before anything was applied. */
export async function retryService(id: string, opts: { dryRun?: boolean } = {}): Promise<{ plan: Plan; change: Change | null; service: ServiceInstance }> {
  const { db } = getContext();
  const inst = getService(db, id);
  if (!inst) throw new ServiceError("No such service.", 404);
  const def = serviceById(inst.serviceId);
  if (!def) throw new ServiceError("This service is no longer in the catalogue.", 409);
  openOrThrow(inst);
  if (inst.status !== "failed" && inst.status !== "inactive") throw new ServiceError("Only a failed or never-applied service can be retried.", 409);
  const platformOf = await platformsOf(inst.scopeId);
  let lines: DeviceLines[];
  if (inst.applied) lines = planModify(def, inst.applied, { values: inst.values, devices: inst.devices }, platformOf);
  else {
    const rendered = renderFor(def, inst.values, inst.devices.map((label) => ({ label, platform: platformOf(label) })));
    lines = rendered.map((r) => ("commands" in r ? { device: r.device, platform: r.platform, commands: r.commands, remove: 0, add: r.commands.length } : { device: r.device, platform: r.platform, error: r.error }));
  }
  const bad = problems(lines);
  if (bad) throw new ServiceError(bad);
  const plan: Plan = { operation: inst.applied ? "modify" : "provision", devices: lines };
  if (opts.dryRun) return { plan, change: null, service: inst };
  const change = await file(inst.scopeId, inst, plan.operation, lines, `Retry ${inst.name}`);
  link(db, id, change, plan.operation, {});
  addAudit(db, { kind: "configuration", actor: "user", summary: `Retrying service "${inst.name}"`, data: { serviceId: id, changeId: change.id } });
  return { plan, change, service: getService(db, id)! };
}

/** Stops tracking a service. Nothing is sent to any device: what is configured there stays configured. */
export function forgetService(id: string): ServiceInstance {
  const { db } = getContext();
  const inst = getService(db, id);
  if (!inst) throw new ServiceError("No such service.", 404);
  if (inst.pending) throw new ServiceError("A change for this service is still open. Finish or reject it first.", 409);
  db.prepare("DELETE FROM service_instances WHERE id = ?").run(id);
  addAudit(db, { kind: "configuration", actor: "user", summary: `Stopped tracking service "${inst.name}" (${inst.status}); nothing was changed on any device`, data: { serviceId: id, status: inst.status } });
  return inst;
}
