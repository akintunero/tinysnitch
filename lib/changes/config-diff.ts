import { normIf } from "../diagnostics/parsers";

/**
 * A running-config as blocks: "" is the global block, every other key is a block header (interface, router ...)
 * and its value is the lines indented under it. This is all the engine needs to verify a change and to compute its
 * rollback, and it is deliberately dialect-agnostic: IOS, NX-OS and EOS all print indented blocks.
 */
export type ConfigBlocks = Map<string, string[]>;

const VOLATILE = /^(building configuration|current configuration\s*:|!|using \d+ out of|last configuration change|nvram config last updated|no configuration change since|ntp clock-period|end$|version\s|\*|boot-(start|end)-marker)/i;

/** Interface names are written in full so `Gi0/1` and `GigabitEthernet0/1` are one block. */
export function headerKey(line: string): string {
  const t = line.trim().replace(/\s+/g, " ");
  const m = t.match(/^(interface)\s+(\S+)$/i);
  return m ? `interface ${normIf(m[2])}` : t;
}

export function parseBlocks(text: string): ConfigBlocks {
  const blocks: ConfigBlocks = new Map([["", []]]);
  let current = "";
  let banner: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (banner !== null) { if (raw.includes(banner)) banner = null; continue; } // banner text is free-form
    const bm = raw.match(/^banner\s+\S+\s+(\S)/);
    if (bm && !raw.slice(raw.indexOf(bm[1]) + 1).includes(bm[1])) { banner = bm[1]; continue; }
    if (!raw.trim() || VOLATILE.test(raw.trim()) && !/^\s/.test(raw)) { if (!/^\s/.test(raw)) current = ""; continue; }
    if (/^\s/.test(raw)) {
      if (VOLATILE.test(raw.trim())) continue;
      blocks.get(current)!.push(raw.trim().replace(/\s+/g, " "));
    } else {
      const key = headerKey(raw);
      // A top-level line is a header if indented lines follow it; until then it is a global line.
      current = key;
      if (!blocks.has(key)) blocks.set(key, []);
    }
  }
  // Header lines with no children are plain global lines, not blocks.
  const out: ConfigBlocks = new Map([["", [...blocks.get("")!]]]);
  for (const [k, v] of blocks) {
    if (k === "") continue;
    if (v.length === 0 && !/^(interface|router|vlan|line|ip access-list|route-map|vrf)/i.test(k)) out.get("")!.push(k);
    else out.set(k, v);
  }
  return out;
}

/** The line a `no ...` command removes, matched by prefix: `no ip address` removes any `ip address ...`. */
const stripNo = (c: string) => c.replace(/^no\s+/i, "");
const OPENS_BLOCK = /^(interface|router|line|vlan|ip access-list|ipv6 access-list|route-map|class-map|policy-map|vrf definition|vrf context|key chain|control-plane|address-family|spanning-tree mst)\b/i;

export type Expectation = { block: string; line: string; kind: "present" | "absent"; command: string };

/** What each command should leave behind in the configuration, so the result can be checked against the device. */
export function expectations(commands: string[]): Expectation[] {
  const out: Expectation[] = [];
  let block = "";
  for (const c of commands) {
    const cmd = c.trim().replace(/\s+/g, " ");
    if (OPENS_BLOCK.test(cmd)) { block = headerKey(cmd); out.push({ block: "", line: block, kind: "present", command: c }); continue; }
    if (/^no\s+/i.test(cmd)) {
      const inner = stripNo(cmd);
      if (OPENS_BLOCK.test(inner)) { out.push({ block: "", line: headerKey(inner), kind: "absent", command: c }); if (block === headerKey(inner)) block = ""; continue; }
      out.push({ block, line: inner, kind: "absent", command: c });
      continue;
    }
    out.push({ block, line: cmd, kind: "present", command: c });
  }
  return out;
}

export type Mismatch = { command: string; expected: string };

/** Commands whose effect is not visible in the configuration afterwards. Reported, never silently passed. */
export function verifyApplied(commands: string[], afterText: string): { ok: boolean; mismatches: Mismatch[] } {
  const after = parseBlocks(afterText);
  const mismatches: Mismatch[] = [];
  for (const e of expectations(commands)) {
    const lines = e.block === "" && e.kind === "present" && OPENS_BLOCK.test(e.line) ? [...after.keys()] : after.get(e.block) ?? [];
    if (e.kind === "present") {
      const ok = e.block === "" && OPENS_BLOCK.test(e.line) ? after.has(e.line) : lines.some((l) => l.toLowerCase() === e.line.toLowerCase());
      // Some platforms print a command in an expanded form; a prefix match on the stable part is accepted for numeric tails.
      if (!ok) mismatches.push({ command: e.command, expected: `"${e.line}" present${e.block ? ` under "${e.block}"` : ""}` });
    } else {
      const gone = e.block === "" && OPENS_BLOCK.test(e.line) ? !after.has(e.line) : !lines.some((l) => l.toLowerCase() === e.line.toLowerCase() || l.toLowerCase().startsWith(`${e.line.toLowerCase()} `));
      if (!gone) mismatches.push({ command: e.command, expected: `"${e.line}" absent${e.block ? ` from "${e.block}"` : ""}` });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Lines that hold one value; setting a new one replaces the old, so rollback re-sets it instead of negating the new. */
const SET_VALUED = /^(ip address|ipv6 address|description|mtu|ip mtu|duplex|speed|shutdown|switchport mode|switchport access vlan|switchport trunk native vlan|switchport trunk encapsulation|ip ospf cost|ip ospf \d+ area|ip ospf area|ip ospf hello-interval|ip ospf dead-interval|ip ospf network|router-id|bgp router-id|hostname|spanning-tree mode|channel-group|vrf forwarding|negotiation|encapsulation|mode|name|ip access-group|ip helper-address|ntp server)\b/i;

const keyOf = (l: string) => {
  const m = l.match(SET_VALUED);
  return m ? m[1].toLowerCase() : l.toLowerCase();
};

export type RollbackPlan = { commands: string[]; blocks: string[] };

/** Which blocks, and which lines inside them, a plan touches. Rollback never reaches beyond this, so someone else's change is left alone. */
export type TouchScope = Map<string, Set<string>>;

export function touchedScope(commands: string[]): TouchScope {
  const scope: TouchScope = new Map();
  const add = (block: string, key: string) => { if (!scope.has(block)) scope.set(block, new Set()); if (key) scope.get(block)!.add(key); };
  for (const e of expectations(commands)) {
    if (e.block === "" && OPENS_BLOCK.test(e.line)) { add(e.line, ""); add("", ""); continue; }
    add(e.block, keyOf(stripNo(e.line)));
  }
  return scope;
}

/**
 * The commands that turn `current` back into `snapshot`, for the blocks that differ. It works from two reads of
 * the device, not from what was pushed, so it is correct even when a push stopped halfway or the device normalised
 * what it was given.
 */
export function rollbackCommands(snapshotText: string, currentText: string, scope?: TouchScope): RollbackPlan {
  const before = parseBlocks(snapshotText), now = parseBlocks(currentText);
  const commands: string[] = [];
  const touched: string[] = [];
  const keys = new Set([...before.keys(), ...now.keys()]);
  // Globals first, then blocks, so objects exist before things refer to them.
  const ordered = [...keys].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0)).filter((k) => !scope || scope.has(k));
  for (const k of ordered) {
    const was = before.get(k), is = now.get(k);
    if (was && !is) { // a block that existed has gone: recreate it with its lines
      commands.push(...(k === "" ? [] : [k]), ...was);
      touched.push(k);
      continue;
    }
    if (!was && is) { // a block that did not exist was created: remove it
      if (k !== "") { commands.push(`no ${k}`); touched.push(k); }
      continue;
    }
    if (!was || !is) continue;
    const mine = scope?.get(k);
    const inScope = (l: string) => !scope || (mine?.has(keyOf(stripNo(l))) ?? false);
    const add = was.filter((l) => !is.includes(l) && inScope(l));
    const del = is.filter((l) => !was.includes(l) && inScope(l));
    if (!add.length && !del.length) continue;
    touched.push(k || "(global)");
    const header = k === "" ? [] : [k];
    const replaced = new Set(add.map(keyOf));
    const removals = del.filter((l) => !(SET_VALUED.test(l) && replaced.has(keyOf(l)))).map((l) => (/^no\s+/i.test(l) ? stripNo(l) : `no ${l}`));
    // A removal of a set-valued default (e.g. "shutdown" appearing) is the negation; a removed `no x` is re-asserted by dropping the "no".
    commands.push(...header, ...removals, ...add.map((l) => l));
  }
  // Compress consecutive repeats of the same header.
  const out: string[] = [];
  for (const c of commands) if (out.at(-1) !== c || !OPENS_BLOCK.test(c)) out.push(c);
  return { commands: out, blocks: touched };
}

/** The blocks that still differ between a snapshot and the device, to report if a rollback did not fully restore it. */
export function remainingDifferences(snapshotText: string, currentText: string): string[] {
  const before = parseBlocks(snapshotText), now = parseBlocks(currentText);
  const out: string[] = [];
  for (const k of new Set([...before.keys(), ...now.keys()])) {
    const a = (before.get(k) ?? []).slice().sort().join("\n"), b = (now.get(k) ?? []).slice().sort().join("\n");
    if (a !== b || before.has(k) !== now.has(k)) out.push(k || "(global)");
  }
  return out;
}
