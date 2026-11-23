/**
 * Which services a problem hurts, and which problems a service is exposed to.
 *
 * A finding names a device and often an interface, and for a link it names the device at the other end too. A service
 * records the devices and interfaces it touches. Joining the two tells an engineer, when a link goes down, which
 * services ride on it, without anyone keeping that list by hand.
 *
 * Two levels of match, kept apart so the page can be honest about how sure it is:
 *   interface: the finding is on an interface (or at the far end of a link) that the service is bound to.
 *   device:    the service lives on that device but is not tied to one interface (a VLAN, an NTP server), or the finding
 *              is about the whole device. The service may or may not really be affected.
 * A service on one interface is not marked as affected by a problem on a different interface of the same device.
 */
import { normIf } from "../diagnostics/parsers";
import type { Finding } from "../diagnostics/types";
import type { ServiceInstance, ServiceStatus } from "./instances";

export type Match = "interface" | "device";
export type Affected = { serviceId: string; name: string; title: string; status: ServiceStatus; match: Match };
export type FindingImpact = { findingId: string; title: string; severity: Finding["severity"]; status: Finding["status"]; device: string; interface: string | null; affected: Affected[] };
export type ServiceExposure = { serviceId: string; name: string; status: ServiceStatus; risks: { findingId: string; title: string; severity: Finding["severity"]; status: Finding["status"]; match: Match }[] };

type FindingLike = Pick<Finding, "id" | "title" | "severity" | "status" | "device" | "interface" | "peer">;

/** Services that are on the devices, or about to be, or that need a look. Retired and never-applied ones are not on anything. */
const LIVE: ServiceStatus[] = ["active", "pending", "failed"];

const sameIf = (a: string | null, b: string | null) => !!a && !!b && normIf(a).toLowerCase() === normIf(b).toLowerCase();

export function matchOf(service: Pick<ServiceInstance, "touches">, f: FindingLike): Match | null {
  let best: Match | null = null;
  const ends = [{ device: f.device, interface: f.interface }, ...(f.peer ? [{ device: f.peer.device, interface: f.peer.interface }] : [])];
  for (const t of service.touches) {
    for (const e of ends) {
      if (t.device !== e.device) continue;
      if (t.interface && e.interface) {
        if (sameIf(t.interface, e.interface)) return "interface";
        continue; // a different interface of the same device is a different thing
      }
      // either side is not tied to an interface: it may be affected, no more than that
      if (!t.interface || !e.interface) best = "device";
    }
  }
  return best;
}

export function computeImpact(services: ServiceInstance[], findings: FindingLike[]): { findings: FindingImpact[]; services: ServiceExposure[] } {
  const live = services.filter((s) => LIVE.includes(s.status));
  const byFinding: FindingImpact[] = findings.map((f) => ({
    findingId: f.id, title: f.title, severity: f.severity, status: f.status, device: f.device, interface: f.interface,
    affected: live.flatMap((s): Affected[] => { const m = matchOf(s, f); return m ? [{ serviceId: s.id, name: s.name, title: s.title, status: s.status, match: m }] : []; }),
  }));
  const rank: Record<Finding["severity"], number> = { critical: 0, warning: 1, info: 2 };
  const byService: ServiceExposure[] = live.map((s) => ({
    serviceId: s.id, name: s.name, status: s.status,
    risks: findings.flatMap((f) => { const m = matchOf(s, f); return m ? [{ findingId: f.id, title: f.title, severity: f.severity, status: f.status, match: m }] : []; })
      .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.match === "interface" ? -1 : 1)),
  }));
  return { findings: byFinding.filter((f) => f.affected.length > 0).sort((a, b) => rank[a.severity] - rank[b.severity]), services: byService.filter((s) => s.risks.length > 0) };
}
