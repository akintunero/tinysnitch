import type { Platform } from "../core/types";
import { driverFor } from "../diagnostics/platforms";
import { remainingDifferences, rollbackCommands, touchedScope, verifyApplied, type Mismatch } from "./config-diff";

/**
 * How a dialect's configuration is checked and undone. IOS, NX-OS and EOS print indented blocks; Junos prints flat
 * `set` lines (`show configuration | display set`). The change engine only talks to this interface.
 */
export interface ConfigModel {
  verify(commands: string[], afterText: string): { ok: boolean; mismatches: Mismatch[] };
  /** Commands that return the touched parts of `currentText` to `snapshotText`. Never reaches outside what the change touched. */
  rollback(snapshotText: string, currentText: string, commands: string[]): { commands: string[]; blocks: string[] };
  /** Parts the change touched that still differ from the snapshot. */
  remaining(snapshotText: string, currentText: string, commands: string[]): string[];
  /** A reason, if these commands would cut off the address Tiny Snitch manages the device on. */
  cutoff(configText: string, platform: Platform, address: string | undefined, commands: string[]): string | null;
}

/** Commands that would cut off the very address Tiny Snitch uses to reach the device (block dialects). */
export function managementCutoff(configText: string, platform: Platform, address: string | undefined, commands: string[]): string | null {
  if (!address) return null;
  const cfg = driverFor(platform)?.parse.config(configText);
  if (!cfg) return null;
  let iface: string | null = null;
  for (const c of commands) {
    const m = c.match(/^interface\s+(\S+)$/i);
    if (m) { iface = m[1]; continue; }
    const ic = iface ? [...cfg.interfaces.values()].find((i) => i.name.toLowerCase() === iface!.toLowerCase() || i.name.toLowerCase().endsWith(iface!.toLowerCase().replace(/^[a-z]+/, ""))) : null;
    if (!ic || ic.ip !== address) continue;
    if (/^shutdown$/i.test(c)) return `"shutdown" on ${ic.name}, which holds ${address}, the address Tiny Snitch reaches this device on`;
    if (/^no\s+ip\s+address/i.test(c)) return `removing the address from ${ic.name}, which holds ${address}, the address Tiny Snitch reaches this device on`;
    if (/^ip\s+address\s+(?!\S+\s+\S+\s+secondary)/i.test(c) && !c.includes(address)) return `changing the address on ${ic.name}, which holds ${address}, the address Tiny Snitch reaches this device on`;
  }
  return null;
}

const BLOCK: ConfigModel = {
  verify: verifyApplied,
  rollback: (snap, cur, cmds) => rollbackCommands(snap, cur, touchedScope(cmds)),
  remaining: (snap, cur, cmds) => {
    const scope = touchedScope(cmds);
    return remainingDifferences(snap, cur).filter((b) => scope.has(b === "(global)" ? "" : b));
  },
  cutoff: managementCutoff,
};

// ---- Junos: flat `set` lines ---------------------------------------------------------------------------------

const norm = (l: string) => l.trim().replace(/\s+/g, " ").replace(/"/g, "");
const setLines = (text: string) => new Set(text.split(/\r?\n/).map(norm).filter((l) => l.startsWith("set ")));
const tokens = (l: string) => norm(l).replace(/^(set|delete) /, "").split(" ");
const startsWith = (a: string[], b: string[]) => b.length <= a.length && b.every((t, i) => a[i] === t);

/** A line is in a change's scope if it lies under a changed path, or is the same leaf (a single value being replaced). */
function inScope(line: string, commands: string[]): boolean {
  const lt = tokens(line);
  const key = lt.slice(0, -1);
  return commands.some((c) => {
    const ct = tokens(c);
    return startsWith(lt, ct) || startsWith(ct, key);
  });
}

function ipOnInterface(cfgText: string, address: string): string | null {
  const m = [...cfgText.matchAll(/^set interfaces (\S+) unit \d+ family inet address (\d+\.\d+\.\d+\.\d+)\/\d+/gm)].find((x) => x[2] === address);
  return m ? m[1] : null;
}

const SET: ConfigModel = {
  verify(commands, after) {
    const have = setLines(after);
    const mismatches: Mismatch[] = [];
    for (const c of commands) {
      const n = norm(c);
      if (n.startsWith("set ")) {
        if (!have.has(n)) mismatches.push({ command: c, expected: `"${n}" present` });
      } else if (n.startsWith("delete ")) {
        const path = `set ${n.slice("delete ".length)}`;
        if ([...have].some((l) => l === path || l.startsWith(`${path} `))) mismatches.push({ command: c, expected: `"${path}" absent` });
      } else mismatches.push({ command: c, expected: "a set or delete command" });
    }
    return { ok: mismatches.length === 0, mismatches };
  },
  rollback(snapshot, current, commands) {
    const was = setLines(snapshot), now = setLines(current);
    const add = [...was].filter((l) => !now.has(l) && inScope(l, commands));
    const del = [...now].filter((l) => !was.has(l) && inScope(l, commands));
    const out = [...del.map((l) => `delete ${l.slice(4)}`), ...add];
    return { commands: out, blocks: [...new Set([...del, ...add].map((l) => tokens(l).slice(0, 3).join(" ")))] };
  },
  remaining(snapshot, current, commands) {
    const was = setLines(snapshot), now = setLines(current);
    return [...new Set([...[...was].filter((l) => !now.has(l)), ...[...now].filter((l) => !was.has(l))].filter((l) => inScope(l, commands)).map((l) => tokens(l).slice(0, 4).join(" ")))].slice(0, 8);
  },
  cutoff(config, _platform, address, commands) {
    if (!address) return null;
    const iface = ipOnInterface(config, address);
    if (!iface) return null;
    for (const c of commands.map(norm)) {
      if (c === `set interfaces ${iface} disable`) return `"disable" on ${iface}, which holds ${address}, the address Tiny Snitch reaches this device on`;
      if (c === `delete interfaces ${iface}` || c.startsWith(`delete interfaces ${iface} unit`)) return `deleting the configuration of ${iface}, which holds ${address}, the address Tiny Snitch reaches this device on`;
    }
    return null;
  },
};

export function modelFor(platform: Platform): ConfigModel {
  return platform === "junos" ? SET : BLOCK;
}
