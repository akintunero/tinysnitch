import { type TopoNode } from "../cml/topology";
import { assessLines, blockedLines } from "../core/safety";
import { type DeviceRef, type DeviceTransport, type Environment, type InventoryProvider, nodeRef } from "../core/types";
import type { Db } from "../database/db";
import { addAudit, getSettings } from "../database/repo";
import { runDiagnostics } from "../diagnostics/engine";
import { driverFor } from "../diagnostics/platforms";
import { openFindings } from "../diagnostics/store";
import { providerFor } from "../providers/registry";
import { getContext } from "../server/context";
import { CLI } from "../transport/ssh";
import { managementCutoff, modelFor } from "./models";
import {
  type Change, type ChangeResult, type DeviceOutcome, type DevicePlan, createChange, getChange, updateChange,
} from "./store";

export class ChangeError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "ChangeError";
  }
}

export const LIMITS = { devices: 20, linesPerDevice: 300, lineChars: 300, autopilotLines: 30, autopilotDevices: 3 };

const TEXT = (s: string) => s.replace(/\s+/g, " ").trim();
const REFUSED = /^\s*%|^\s*error:|syntax error|invalid input|incomplete command|unknown command/i;

/** What the engine will refuse to proceed with, and what it merely points out. */
export type Validation = { devices: DevicePlan[]; warnings: string[] };

function cleanCommands(raw: string[]): { commands: string[]; dropped: string[] } {
  const dropped: string[] = [];
  const commands: string[] = [];
  for (const line of raw.flatMap((l) => l.split(/\r?\n/))) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("!")) { dropped.push(t); continue; } // a comment
    if (/^(conf(igure)?(\s+t(erminal)?)?|end)$/i.test(t)) { dropped.push(t); continue; } // Tiny Snitch enters and leaves config mode itself
    commands.push(t);
  }
  return { commands, dropped };
}

/** Pre-deployment validation: nothing here talks to a device. Anything that makes the change unsafe to send is a hard error. */
export function validatePlan(nodes: TopoNode[], provider: InventoryProvider, input: { device: string; commands: string[] }[], transport?: DeviceTransport): Validation {
  if (!input.length) throw new ChangeError("A change needs at least one device.", 400);
  if (input.length > LIMITS.devices) throw new ChangeError(`A change may touch at most ${LIMITS.devices} devices; this one touches ${input.length}. Split it up.`, 400);
  const devices: DevicePlan[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const d of input) {
    const node = nodes.find((n) => n.label === d.device);
    if (!node) throw new ChangeError(`There is no device named "${d.device}" in this network.`, 400);
    if (seen.has(node.id)) throw new ChangeError(`${d.device} appears twice; put all of its commands in one entry.`, 400);
    seen.add(node.id);
    const platform = node.platform ?? "ios";
    if (!driverFor(platform)) throw new ChangeError(`${d.device}: ${platform} devices are not supported yet.`, 400);
    const support = transport?.pushSupport?.(nodeRef(node)) ?? (CLI[platform].configEnter ? { ok: true as const } : { ok: false as const, reason: `configuration changes are not supported for ${platform} devices over this connection` });
    if (!support.ok) throw new ChangeError(`${d.device}: ${support.reason}.`, 400);
    const can = provider.inspectable(node);
    if (!can.ok) throw new ChangeError(`${d.device} cannot be changed right now: ${can.reason}`, 400);
    const { commands, dropped } = cleanCommands(d.commands);
    if (!commands.length) throw new ChangeError(`${d.device}: no commands to apply.`, 400);
    if (commands.length > LIMITS.linesPerDevice) throw new ChangeError(`${d.device}: at most ${LIMITS.linesPerDevice} lines per device.`, 400);
    const long = commands.find((c) => c.length > LIMITS.lineChars);
    if (long) throw new ChangeError(`${d.device}: a line is longer than ${LIMITS.lineChars} characters.`, 400);
    const risks = assessLines(commands, platform);
    const bad = risks.filter((r) => r.risk === "blocked");
    if (bad.length) throw new ChangeError(`${d.device}: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}. Tiny Snitch never sends that${bad.length > 1 ? ` (and ${bad.length - 1} more line${bad.length > 2 ? "s" : ""} like it)` : ""}.`, 400);
    if (dropped.length) warnings.push(`${d.device}: ignored ${dropped.length} line(s) Tiny Snitch supplies itself or that were comments.`);
    const high = risks.filter((r) => r.risk === "high");
    if (high.length) warnings.push(`${d.device}: ${high.length} high-risk line(s): ${high.slice(0, 3).map((h) => `"${h.line.slice(0, 40)}" ${h.reason}`).join("; ")}.`);
    devices.push({ deviceId: node.id, label: node.label, platform, commands, risks });
  }
  return { devices, warnings };
}

const modeOf = (db: Db) => getSettings(db).executionMode;

/** Whether the execution mode allows applying a change without a person approving it. Production never qualifies. */
export function autoApprovable(change: Pick<Change, "environment" | "plan" | "source">, mode: string, allowConfig: boolean): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (mode !== "autopilot") reasons.push("Autopilot is not enabled.");
  else if (!allowConfig) reasons.push("Autopilot is on, but \"allow configuration changes\" is off in Settings.");
  if (change.environment !== "lab") reasons.push("Only lab networks can be changed without approval; this one is production.");
  const lines = change.plan.devices.reduce((n, d) => n + d.commands.length, 0);
  if (lines > LIMITS.autopilotLines) reasons.push(`It has ${lines} lines; Autopilot allows at most ${LIMITS.autopilotLines}.`);
  if (change.plan.devices.length > LIMITS.autopilotDevices) reasons.push(`It touches ${change.plan.devices.length} devices; Autopilot allows at most ${LIMITS.autopilotDevices}.`);
  if (change.plan.devices.some((d) => d.risks.some((r) => r.risk === "high"))) reasons.push("It contains high-risk lines, which always need a person's approval.");
  return { ok: reasons.length === 0, reasons };
}

export async function proposeChange(input: { scopeId: string; title: string; intent: string; source: Change["source"]; devices: { device: string; commands: string[] }[] }): Promise<Change> {
  const ctx = getContext();
  const { provider } = providerFor(input.scopeId);
  if (!provider) throw new ChangeError("No inventory provides that network.", 404);
  const topology = await provider.getTopology(input.scopeId);
  const v = validatePlan(topology.nodes, provider, input.devices, provider.transport(input.scopeId));
  const environment: Environment = topology.lab.environment ?? "lab";
  const change = createChange(ctx.db, { scopeId: input.scopeId, environment, title: input.title.trim().slice(0, 120) || "Untitled change", intent: input.intent.trim().slice(0, 2000), source: input.source, plan: { devices: v.devices, warnings: v.warnings } });
  addAudit(ctx.db, { kind: "configuration", actor: input.source === "assistant" ? "claude" : "user", summary: `Proposed change "${change.title}" for ${v.devices.length} device(s) (${environment})`, data: { changeId: change.id, scopeId: input.scopeId, devices: v.devices.map((d) => ({ device: d.label, lines: d.commands.length })) } });
  return change;
}

export function approveChange(id: string, actor = "user"): Change {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  if (c.status !== "proposed") throw new ChangeError(`This change is ${c.status.replace("_", " ")}, so it cannot be approved.`);
  if (modeOf(ctx.db) === "suggest") throw new ChangeError("Suggest mode only drafts changes for review. Switch to Approve-and-deploy in Settings to apply them.");
  const out = updateChange(ctx.db, id, { status: "approved", approvedAt: new Date().toISOString(), approvedBy: actor });
  addAudit(ctx.db, { kind: "approval", actor, summary: `Approved change "${c.title}"`, data: { changeId: id, environment: c.environment } });
  return out;
}

export function rejectChange(id: string): Change {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  if (c.status !== "proposed" && c.status !== "approved") throw new ChangeError(`This change is ${c.status.replace("_", " ")}, so it cannot be rejected.`);
  addAudit(ctx.db, { kind: "approval", actor: "user", summary: `Rejected change "${c.title}"`, data: { changeId: id } });
  return updateChange(ctx.db, id, { status: "rejected" });
}

/**
 * One change at a time per network. Each holder gets its own token, and its release frees the lock only if that token
 * still holds it: a run that was abandoned (a timeout, say) and finishes late cannot free the lock a newer run took.
 */
const busy = new Map<string, symbol>();

export function acquireNetworkLock(scopeId: string): () => void {
  const token = Symbol(scopeId);
  busy.set(scopeId, token);
  return () => {
    if (busy.get(scopeId) === token) busy.delete(scopeId);
  };
}

export const isNetworkBusy = (scopeId: string) => busy.has(scopeId);

/** Clears every lock. For tests, so one that times out or aborts cannot leave a lock that fails the next. */
export function resetChangeLocks(): void {
  busy.clear();
}

type Env = { db: Db; provider: InventoryProvider; transport: DeviceTransport; nodes: Map<string, TopoNode> };

async function readConfig(t: DeviceTransport, ref: DeviceRef): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const r = await t.run(ref, driverFor(ref.platform)?.commands.config ?? "show running-config");
  if (!r.ok) return { ok: false, reason: r.text.split("\n")[0].slice(0, 200) };
  if (!r.text.trim() || REFUSED.test(r.text.split("\n").find((l) => l.trim()) ?? "")) return { ok: false, reason: "The device did not return its configuration." };
  return { ok: true, text: r.text };
}

export { managementCutoff };

async function rollbackDevice(env: Env, change: Change, d: DevicePlan, out: DeviceOutcome): Promise<boolean> {
  const snap = change.snapshot?.[d.label];
  const node = env.nodes.get(d.deviceId);
  if (snap === undefined || !node) { out.steps.push("No snapshot exists for this device, so it cannot be rolled back automatically."); return false; }
  const ref = nodeRef(node);
  const now = await readConfig(env.transport, ref);
  if (!now.ok) { out.steps.push(`Could not read the device to roll it back: ${now.reason}`); return false; }
  const model = modelFor(d.platform);
  const plan = model.rollback(snap, now.text, d.commands);
  if (!plan.commands.length) { out.steps.push("Already matches the snapshot; nothing to undo."); out.rolledBack = true; out.remaining = []; return true; }
  out.steps.push(`Rolling back ${plan.blocks.length} section(s) with ${plan.commands.length} command(s).`);
  const pushed = await env.transport.push(ref, plan.commands, { final: true });
  if (!pushed.ok) { out.steps.push(`Rollback was rejected at "${pushed.failedAt ?? "?"}": ${pushed.text.split("\n").slice(-2).join(" ").slice(0, 200)}`); out.rolledBack = false; return false; }
  const after = await readConfig(env.transport, ref);
  if (!after.ok) { out.steps.push(`Rolled back, but the result could not be read to confirm: ${after.reason}`); out.rolledBack = false; return false; }
  // Only the parts this change touched are compared; drift elsewhere is not this change's business.
  const diff = model.remaining(snap, after.text, d.commands);
  out.remaining = diff;
  out.rolledBack = diff.length === 0;
  out.steps.push(diff.length ? `Rolled back, but these sections still differ from the snapshot: ${diff.join(", ")}.` : "Rolled back and confirmed: the configuration matches the snapshot.");
  return diff.length === 0;
}

function emptyOutcome(label: string): DeviceOutcome {
  return { label, steps: [], pushed: false, verified: null, mismatches: [], rolledBack: null, remaining: [] };
}

async function resolveEnv(change: Change): Promise<Env> {
  const ctx = getContext();
  const { provider } = providerFor(change.scopeId);
  if (!provider) throw new ChangeError("No inventory provides that network any more.", 404);
  const topology = await provider.getTopology(change.scopeId, true);
  return { db: ctx.db, provider, transport: provider.transport(change.scopeId), nodes: new Map(topology.nodes.map((n) => [n.id, n])) };
}

/**
 * Applies an approved change: snapshot every device first (and stop if any cannot be read), push device by device,
 * verify against a fresh read of each device, re-run diagnostics to catch new problems, and undo the change itself if
 * the push fails. Nothing is reported as done that was not read back from the device.
 */
/** The checks that must pass before a deployment may start. The API runs them before going to the background. */
export function assertDeployable(id: string): Change {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  if (c.status !== "approved") throw new ChangeError(c.status === "proposed" ? "This change has not been approved yet." : `This change is ${c.status.replace("_", " ")}, so it cannot be deployed.`);
  if (modeOf(ctx.db) === "suggest") throw new ChangeError("Suggest mode only drafts changes for review. Switch to Approve-and-deploy in Settings to apply them.");
  if (busy.has(c.scopeId)) throw new ChangeError("Another change is being applied to this network. Wait for it to finish.");
  return c;
}

export async function deployChange(id: string): Promise<Change> {
  const ctx = getContext();
  const c0 = assertDeployable(id);
  const mode = modeOf(ctx.db);
  const result: ChangeResult = { startedAt: new Date().toISOString(), finishedAt: null, summary: "", devices: [], regressions: [], saved: false };
  const outcomes = new Map<string, DeviceOutcome>(c0.plan.devices.map((d) => [d.label, emptyOutcome(d.label)]));
  const finish = (status: Change["status"], summary: string, snapshot?: Record<string, string>) => {
    result.finishedAt = new Date().toISOString();
    result.summary = summary;
    result.devices = c0.plan.devices.map((d) => outcomes.get(d.label)!);
    addAudit(ctx.db, { kind: "configuration", actor: "system", summary: `Change "${c0.title}": ${status}. ${summary}`.slice(0, 480), data: { changeId: id, status, environment: c0.environment } });
    return updateChange(ctx.db, id, { status, result, ...(snapshot ? { snapshot } : {}) });
  };
  // Taken straight before the try, with nothing in between that could throw, so it is always released in the finally.
  const release = acquireNetworkLock(c0.scopeId);
  try {
    updateChange(ctx.db, id, { status: "deploying" });
    addAudit(ctx.db, { kind: "configuration", actor: "system", summary: `Deploying change "${c0.title}" to ${c0.plan.devices.length} device(s)`, data: { changeId: id } });
    const env = await resolveEnv(c0);

    // 1. Snapshot everything before touching anything.
    const snapshot: Record<string, string> = {};
    for (const d of c0.plan.devices) {
      const node = env.nodes.get(d.deviceId);
      const out = outcomes.get(d.label)!;
      if (!node) return finish("failed", `${d.label} is no longer in the network. Nothing was changed.`);
      const can = env.provider.inspectable(node);
      if (!can.ok) { out.steps.push(can.reason); return finish("failed", `${d.label} cannot be reached: ${can.reason} Nothing was changed.`); }
      const cfg = await readConfig(env.transport, nodeRef(node));
      if (!cfg.ok) { out.steps.push(`Could not read the configuration first: ${cfg.reason}`); return finish("failed", `Could not take a snapshot of ${d.label} (${cfg.reason}). Nothing was changed.`); }
      snapshot[d.label] = cfg.text;
      out.steps.push("Snapshot of the running configuration taken.");
      const cut = modelFor(d.platform).cutoff(cfg.text, d.platform, node.address, d.commands);
      if (cut) { out.steps.push(`Stopped: ${cut}.`); return finish("failed", `Refused to apply: ${d.label} would lose contact with Tiny Snitch (${cut}). Nothing was changed.`, snapshot); }
    }
    updateChange(ctx.db, id, { snapshot });
    const before = new Set(openFindings(ctx.db, c0.scopeId).map((f) => f.id));
    const change: Change = { ...c0, snapshot };

    // 2. Push, device by device. Stop at the first failure and undo what was done.
    const touched: DevicePlan[] = [];
    for (const d of c0.plan.devices) {
      const node = env.nodes.get(d.deviceId)!;
      const out = outcomes.get(d.label)!;
      touched.push(d);
      const r = await env.transport.push(nodeRef(node), d.commands);
      out.pushed = r.ok;
      if (!r.ok) {
        out.steps.push(`Rejected${r.failedAt ? ` at "${r.failedAt}"` : ""}: ${r.text.split("\n").filter((l) => l.trim()).slice(-2).join(" ").slice(0, 200)}`);
        let allBack = true;
        for (const t of touched) allBack = (await rollbackDevice(env, change, t, outcomes.get(t.label)!)) && allBack;
        return finish(allBack ? "rolled_back" : "rollback_failed", allBack ? `${d.label} rejected the change, so it was rolled back everywhere. Nothing remains applied.` : `${d.label} rejected the change and the rollback did not fully restore every device. Review the steps below.`);
      }
      out.steps.push(`Applied ${d.commands.length} line(s).`);
    }

    // 3. Verify against a fresh read of every device.
    let verifiedAll = true;
    for (const d of c0.plan.devices) {
      const node = env.nodes.get(d.deviceId)!;
      const out = outcomes.get(d.label)!;
      const after = await readConfig(env.transport, nodeRef(node));
      if (!after.ok) { out.verified = false; out.steps.push(`Could not read the device back to verify: ${after.reason}`); verifiedAll = false; continue; }
      const v = modelFor(d.platform).verify(d.commands, after.text);
      out.verified = v.ok;
      out.mismatches = v.mismatches;
      out.steps.push(v.ok ? "Verified: every line is present in the running configuration." : `Not verified: ${v.mismatches.length} line(s) do not show in the running configuration.`);
      if (!v.ok) verifiedAll = false;
    }

    // 4. Look for new problems with the same read-only checks as Diagnostics.
    try {
      const run = await runDiagnostics(c0.scopeId, { pings: true });
      result.regressions = run.findings.filter((f) => !before.has(f.id) && f.severity !== "info").map((f) => ({ id: f.id, title: f.title, device: f.device, severity: f.severity }));
    } catch (e) {
      for (const o of outcomes.values()) o.steps.push(`Diagnostics could not be re-run afterwards: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}`);
    }

    const criticalNew = result.regressions.some((r) => r.severity === "critical");
    const autopilot = mode === "autopilot" && c0.environment === "lab";
    if (autopilot && (!verifiedAll || criticalNew)) {
      for (const d of c0.plan.devices) await rollbackDevice(env, change, d, outcomes.get(d.label)!);
      const ok = c0.plan.devices.every((d) => outcomes.get(d.label)!.rolledBack);
      return finish(ok ? "rolled_back" : "rollback_failed", `${!verifiedAll ? "Verification failed" : "New critical problems appeared"}, so Autopilot rolled the change back${ok ? "" : ", but not every device was restored"}.`);
    }
    if (!verifiedAll) return finish("failed", "The change was applied but could not be fully verified. Review the steps and roll back if it is wrong.");
    // Platforms with provisional commits revert by themselves unless the change is confirmed: do it only now that it is verified.
    if (env.transport.confirm) {
      let confirmedAll = true;
      for (const d of c0.plan.devices) {
        const out = outcomes.get(d.label)!;
        const r = await env.transport.confirm(nodeRef(env.nodes.get(d.deviceId)!));
        if (r.ok && r.text === "Nothing to confirm.") continue; // this device's push was final already
        out.steps.push(r.ok ? "Confirmed: the change is now permanent on the device." : `Could not confirm the change: ${r.text.split("\n")[0].slice(0, 160)}. The device will revert it by itself when its confirm timer ends.`);
        confirmedAll = confirmedAll && r.ok;
      }
      if (!confirmedAll) return finish("failed", "The change was applied and verified, but could not be made permanent on every device; devices that were not confirmed will revert it on their own. Check them before trying again.");
    }
    return finish("verified", result.regressions.length ? `Applied and verified, but ${result.regressions.length} new finding(s) appeared. Review them and roll back if the change caused them.` : "Applied and verified on every device. No new findings.");
  } catch (e) {
    return finish("failed", `The deployment stopped unexpectedly: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}. Check each device before trying again.`);
  } finally {
    release();
  }
}

export function assertRollbackable(id: string): Change {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  if (!["verified", "failed", "rollback_failed"].includes(c.status)) throw new ChangeError(`This change is ${c.status.replace("_", " ")}, so there is nothing to roll back.`);
  if (!c.snapshot) throw new ChangeError("No snapshot was taken before this change, so it cannot be rolled back automatically.");
  if (modeOf(ctx.db) === "suggest") throw new ChangeError("Suggest mode does not change devices.");
  if (busy.has(c.scopeId)) throw new ChangeError("Another change is being applied to this network. Wait for it to finish.");
  return c;
}

/** Puts every device the change touched back as the snapshot had it, for the parts the change touched. */
export async function rollbackChange(id: string): Promise<Change> {
  const ctx = getContext();
  const c = assertRollbackable(id);
  const release = acquireNetworkLock(c.scopeId);
  try {
    updateChange(ctx.db, id, { status: "rolling_back" });
    const env = await resolveEnv(c);
    const outcomes = c.plan.devices.map((d) => ({ d, out: { ...emptyOutcome(d.label), pushed: c.result?.devices.find((x) => x.label === d.label)?.pushed ?? false } }));
    let all = true;
    for (const { d, out } of outcomes) all = (await rollbackDevice(env, c, d, out)) && all;
    const result: ChangeResult = { ...(c.result ?? { startedAt: new Date().toISOString(), regressions: [], saved: false }), finishedAt: new Date().toISOString(), summary: all ? "Rolled back and confirmed against the snapshot." : "Rollback did not fully restore every device. Review the steps.", devices: outcomes.map((o) => o.out), saved: false };
    addAudit(ctx.db, { kind: "configuration", actor: "user", summary: `Rolled back change "${c.title}": ${all ? "confirmed" : "incomplete"}`, data: { changeId: id } });
    return updateChange(ctx.db, id, { status: all ? "rolled_back" : "rollback_failed", result });
  } catch (e) {
    return updateChange(ctx.db, id, { status: "rollback_failed", result: { ...(c.result ?? { startedAt: new Date().toISOString(), regressions: [], saved: false, devices: [] }), finishedAt: new Date().toISOString(), summary: `The rollback stopped unexpectedly: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}. Check each device.`, devices: c.result?.devices ?? [] } });
  } finally {
    release();
  }
}

/** Copies running to startup on every device the change touched. A separate, explicit decision. */
export async function saveChange(id: string): Promise<Change> {
  const ctx = getContext();
  const c = getChange(ctx.db, id);
  if (!c) throw new ChangeError("No such change.", 404);
  if (c.status !== "verified") throw new ChangeError("Only a verified change can be saved to startup.");
  if (c.result?.saved) throw new ChangeError("This change was already saved.");
  const env = await resolveEnv(c);
  const result: ChangeResult = { ...c.result!, devices: c.result!.devices.map((d) => ({ ...d, steps: [...d.steps] })) };
  let all = true;
  for (const d of c.plan.devices) {
    const node = env.nodes.get(d.deviceId);
    const out = result.devices.find((x) => x.label === d.label)!;
    const r = node ? await env.transport.save(nodeRef(node)) : { ok: false, text: "The device is gone." };
    out.steps.push(r.ok ? "Saved to startup configuration." : `Could not save to startup: ${r.text.split("\n")[0].slice(0, 160)}`);
    all = all && r.ok;
  }
  result.saved = all;
  addAudit(ctx.db, { kind: "configuration", actor: "user", summary: `Saved change "${c.title}" to startup: ${all ? "ok" : "failed on some devices"}`, data: { changeId: id } });
  return updateChange(ctx.db, id, { result });
}

/**
 * The assistant (or any caller) proposes a change; if Autopilot is on and the change qualifies, it is approved and
 * deployed at once, otherwise it waits for a person. Returns what happened in words the caller can pass on.
 */
export async function proposeAndMaybeApply(input: Parameters<typeof proposeChange>[0]): Promise<{ change: Change; applied: boolean; note: string }> {
  const ctx = getContext();
  let change = await proposeChange(input);
  const mode = modeOf(ctx.db);
  const auto = autoApprovable(change, mode, getSettings(ctx.db).autopilotAllowConfig);
  if (!auto.ok) {
    return { change, applied: false, note: mode === "suggest" ? "Suggest mode: the change is drafted for review only and has not been applied." : `Not applied. It is waiting for a person to approve it${auto.reasons.length ? ` (${auto.reasons.join(" ")})` : ""}.` };
  }
  change = approveChange(change.id, "autopilot");
  change = await deployChange(change.id);
  return { change, applied: change.status === "verified", note: `Autopilot applied it: ${change.result?.summary ?? change.status}` };
}

export { getChange };
