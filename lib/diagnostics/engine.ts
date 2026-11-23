import { randomUUID } from "node:crypto";
import type { TopoNode } from "../cml/topology";
import { type DeviceRef, nodeRef } from "../core/types";
import { addAudit } from "../database/repo";
import { hasCliRunner } from "../providers/cml";
import { providerFor } from "../providers/registry";
import { redactSecrets } from "../security/redact";
import { getContext } from "../server/context";
import { HttpError } from "../server/http";
import { requireMcp } from "../server/labs";
import { analyse } from "./checks";
import { CMD, type CommandKey } from "./commands";
import { normIf } from "./parsers";
import { driverFor, keysFor } from "./platforms";
import { type StoredFinding, openFindings, saveRun } from "./store";
import type { CommandResult, DeviceReport, DeviceSnapshot, PingResult, RunSummary } from "./types";

/** Stated plainly in every run so nobody reads silence as a clean bill of health for these. */
export const NOT_CHECKED = [
  "Incorrect next hops, routing loops and missing routes",
  "Spanning-tree inconsistencies",
  "Conflicting ACLs",
  "Host default gateways",
  "Traceroute paths and asymmetric reachability",
  "Devices that are not IOS routers or switches (hosts, connectors, firewalls)",
];

const MAX_PINGS = 12;
const running = new Set<string>();

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

export type DiagnosticsResult = { run: RunSummary; findings: StoredFinding[]; opened: number; cleared: number };

/**
 * Reads the network's devices with read-only commands, runs the deterministic checks, and stores what it found.
 * It never writes to a device and never concludes anything about a device it could not read. Where the devices are
 * and how they are reached is the provider's and transport's business; this function knows neither.
 */
export async function runDiagnostics(scopeId: string, opts: { pings?: boolean } = {}): Promise<DiagnosticsResult> {
  if (running.has(scopeId)) throw new HttpError(409, "Diagnostics are already running for this lab.");
  running.add(scopeId);
  try {
    const ctx = getContext();
    const { provider } = providerFor(scopeId);
    if (!provider) throw new HttpError(503, ctx.mcpConfigError ?? "No inventory provides that network. Check the CML connection or the inventory file.", "mcp_unavailable");
    if (provider.kind === "cml") {
      const { mcp } = await requireMcp(); // connects first, so the tool list is known
      if (!hasCliRunner(mcp)) throw new HttpError(501, "The CML MCP server has no tool Tiny Snitch can use to run read-only CLI commands, so devices cannot be inspected.", "capability_missing");
    }
    const startedAt = new Date().toISOString();
    const topology = await provider.getTopology(scopeId, true);
    const transport = provider.transport(scopeId);

    const exec = async (node: TopoNode, command: string): Promise<CommandResult> => {
      const r = await transport.run(nodeRef(node), command);
      return { ok: r.ok, text: redactSecrets(r.text), command };
    };

    const devices: DeviceReport[] = [];
    const snapshots = new Map<string, DeviceSnapshot>();
    const targets: { node: TopoNode; keys: CommandKey[] }[] = [];
    const limits = new Set<string>();
    for (const n of topology.nodes) {
      const base = { nodeId: n.id, label: n.label, kind: n.kind, commandsRun: 0, commandsFailed: 0 };
      const can = provider.inspectable(n);
      const driver = driverFor(n.platform);
      const keys = driver ? keysFor(n.kind, driver) : null;
      if (!can.ok) devices.push({ ...base, inspected: false, reason: can.reason });
      else if (!driver) devices.push({ ...base, inspected: false, reason: `No parser for ${n.platform ?? "this"} devices yet, so nothing can be concluded about it.` });
      else if (!keys?.length) devices.push({ ...base, inspected: false, reason: `Not ${driver.id === "ios" ? "an IOS" : "a"} router or switch that Tiny Snitch can inspect.` });
      else { targets.push({ node: n, keys }); for (const l of driver.limits) limits.add(l); }
    }

    await mapLimit(targets, 3, async ({ node, keys }) => {
      const driver = driverFor(node.platform)!;
      const commands: Record<string, CommandResult> = {};
      for (const k of keys) commands[CMD[k]] = await exec(node, driver.commands[k]!);
      const failed = Object.values(commands).filter((c) => !c.ok).length;
      snapshots.set(node.id, { nodeId: node.id, label: node.label, kind: node.kind, commands });
      devices.push({
        nodeId: node.id, label: node.label, kind: node.kind, inspected: failed < keys.length, commandsRun: keys.length, commandsFailed: failed,
        // When nothing could be read, say why in the device's own terms (unreachable, login refused...) rather than a bare count.
        reason: failed === keys.length ? `Every command failed. ${Object.values(commands)[0]?.text.split("\n")[0].slice(0, 160) ?? ""}`.trim() : null,
      });
      addAudit(ctx.db, { kind: "diagnostic", actor: "system", summary: `Read ${keys.length - failed} of ${keys.length} commands from ${node.label}`, data: { scopeId, device: node.label, via: transport.kind, failed: Object.entries(commands).filter(([, c]) => !c.ok).map(([c]) => c) } });
    });

    // Reachability between directly connected neighbours whose interfaces both report up/up.
    const pings: PingResult[] = [];
    if (opts.pings !== false) {
      const first = analyse(topology, snapshots, []);
      const byId = new Map(topology.nodes.map((n) => [n.id, n]));
      const jobs: { l: (typeof topology.links)[number]; from: TopoNode; toIp: string }[] = [];
      for (const l of topology.links) {
        const a = first.interfaces[l.source]?.[normIf(l.sourceInterface)], b = first.interfaces[l.target]?.[normIf(l.targetInterface)];
        if (!a?.ip || !b?.ip || a.status !== "up" || a.protocol !== "up" || b.status !== "up" || b.protocol !== "up") continue;
        jobs.push({ l, from: byId.get(l.source)!, toIp: b.ip });
      }
      await mapLimit(jobs.slice(0, MAX_PINGS), 3, async ({ l, from, toIp }) => {
        const driver = driverFor(from.platform)!;
        const r = await exec(from, driver.ping(toIp));
        const parsed = r.ok ? driver.parse.ping(r.text) : null;
        pings.push({ fromId: from.id, from: from.label, to: topology.nodes.find((n) => n.id === l.target)?.label ?? "", toIp, linkId: l.id, successRate: parsed?.successRate ?? null, sent: parsed?.sent ?? null, output: r.text, error: r.ok ? undefined : r.text });
      });
    }

    const analysis = analyse(topology, snapshots, pings);
    const finishedAt = new Date().toISOString();
    const run: RunSummary = {
      id: randomUUID(), labId: scopeId, startedAt, finishedAt,
      devices: devices.sort((a, b) => a.label.localeCompare(b.label)),
      interfaces: analysis.interfaces,
      pings: pings.map((p) => ({ linkId: p.linkId, ok: p.successRate === 100, successRate: p.successRate })),
      notRun: [...NOT_CHECKED, ...limits],
    };
    const { opened, cleared } = saveRun(ctx.db, run, analysis.findings);
    const inspected = devices.filter((d) => d.inspected).length;
    const crit = analysis.findings.filter((f) => f.severity === "critical").length;
    addAudit(ctx.db, { kind: "diagnostic", actor: "user", summary: `Diagnostics on "${topology.lab.title}": ${inspected} of ${devices.length} devices inspected, ${analysis.findings.length} findings (${crit} critical)`, data: { labId: scopeId, runId: run.id, opened, cleared } });
    return { run, findings: openFindings(ctx.db, scopeId), opened, cleared };
  } finally {
    running.delete(scopeId);
  }
}

export type { DeviceRef };
