import { z } from "zod";
import { addAudit, getSettings } from "@/lib/database/repo";
import { providerFor } from "@/lib/providers/registry";
import { BASELINE_MAX_DAYS, checkDevices, revokeSignOff, signOff } from "@/lib/readiness";
import { currentActor } from "@/lib/security/actor";
import { getContext } from "@/lib/server/context";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { LAB_ID } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

async function load(scope: string | null) {
  const { db } = getContext();
  const id = scope ?? getSettings(db).selectedLabId;
  if (!id) throw new HttpError(409, "Select a network first.");
  const r = LAB_ID.safeParse(id);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  const { provider } = providerFor(r.data);
  if (!provider) throw new HttpError(404, "No inventory provides that network.");
  const topology = await provider.getTopology(r.data);
  return { db, scopeId: r.data, provider, topology };
}

/** Each device's readiness to go live on this network, and whether the gate is on. */
export const GET = route(async (req) => {
  const { db, scopeId, provider, topology } = await load(new URL(req.url).searchParams.get("scope"));
  const environment = topology.lab.environment ?? "lab";
  return json({
    scopeId,
    environment,
    required: environment === "production" && getSettings(db).requireDeviceReadiness,
    baselineMaxDays: BASELINE_MAX_DAYS,
    devices: checkDevices(db, scopeId, topology.nodes, provider, provider.transport(scopeId)),
  });
});

const body = z.object({ scopeId: z.string().optional(), device: z.string().min(1).max(120), action: z.enum(["signoff", "revoke"]), note: z.string().max(300).optional() }).strict();

/** An approver says a device is ready to go live, or takes that back. Changes nothing on the device. */
export const POST = route(async (req) => {
  const b = await readJson(req, body);
  const { db, scopeId, provider, topology } = await load(b.scopeId ?? null);
  if (!topology.nodes.some((n) => n.label === b.device)) throw new HttpError(404, `There is no device named "${b.device}" in this network.`);
  const by = currentActor()?.username ?? "user";
  if (b.action === "signoff") {
    const node = topology.nodes.find((n) => n.label === b.device)!;
    // A person may not vouch for a device that fails the checks they cannot override.
    const failing = checkDevices(db, scopeId, [node], provider, provider.transport(scopeId)).find((d) => d.checks.some((c) => !c.ok && c.id !== "signoff"));
    if (failing) throw new HttpError(409, `${b.device} is not ready yet: ${failing.checks.find((c) => !c.ok && c.id !== "signoff")!.detail}`);
    signOff(db, scopeId, b.device, by, b.note ?? "");
    addAudit(db, { kind: "approval", actor: by === "user" ? "user" : `user:${by}`, summary: `Signed off ${b.device} as ready to go live`, data: { scopeId, device: b.device } });
  } else {
    if (!revokeSignOff(db, scopeId, b.device)) throw new HttpError(404, "That device had no sign-off.");
    addAudit(db, { kind: "approval", actor: by === "user" ? "user" : `user:${by}`, summary: `Withdrew the go-live sign-off for ${b.device}`, data: { scopeId, device: b.device } });
  }
  return json({ ok: true });
}, { write: true, role: "approver" });
