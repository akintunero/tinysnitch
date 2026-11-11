/**
 * What may be sent to a device in configuration mode. Two tiers:
 *  - blocked: never sent by Tiny Snitch, whoever approved it. These destroy state or lock people out.
 *  - high risk: can be sent after approval, but are never applied automatically and are called out in review.
 */
export type LineRisk = "blocked" | "high" | "normal";
export type LineAssessment = { line: string; risk: LineRisk; reason: string | null };

const BLOCKED: [RegExp, string][] = [
  [/^(do\s+)?(reload|reboot|restart)\b/i, "reloads the device"],
  [/^(do\s+)?(write\s+erase|erase|format|delete|fsck|squeeze)\b/i, "erases configuration or storage"],
  [/^(do\s+)?(copy|archive|configure\s+replace|boot|install|license|upgrade)\b/i, "moves files or changes software images"],
  [/^crypto\s+key\s+(zeroize|generate|import)\b/i, "changes device keys"],
  [/^no\s+crypto\b/i, "removes crypto configuration"],
  [/^(do\s+)?(debug|undebug)\b/i, "debug output can overload a device"],
  [/^(do\s+)?(clear)\b/i, "clears device state"],
  [/^(do\s+)?(terminal|monitor)\b/i, "not a configuration command"],
  [/^(do\s+)?(show|ping|traceroute)\b/i, "not a configuration command; use the read-only path"],
  [/^(do\s+)?configure\b/i, "mode changes are handled by Tiny Snitch"],
  [/^(end|exit)$/i, "mode changes are handled by Tiny Snitch"],
  // Junos: operational and file commands, and anything that bypasses the candidate-configuration workflow.
  [/^(request|rollback|commit|run|start|file|load|save|restart)\b/i, "is an operational or commit command; Tiny Snitch manages commits itself"],
  [/^(set|delete)\s+system\s+(login\s+user\s+\S+\s+authentication|root-authentication)\b.*(plain-text|encrypted)/i, "sets a literal credential; credentials are never sent through a change"],
];

const HIGH: [RegExp, string][] = [
  [/^(username|enable\s+(secret|password)|aaa\b|tacacs|radius|snmp-server\s+(community|user|group))/i, "changes who can log in or manage the device"],
  [/^no\s+(username|enable|aaa|tacacs|radius)/i, "removes access control"],
  [/^no\s+feature\b/i, "turns off a whole NX-OS feature"],
  [/^(set|delete)\s+system\s+(login|root-authentication|services\s+(ssh|netconf)|host-name|radius-server|tacplus-server)\b/i, "changes who can log in or reach the device"],
  [/^delete\s+(interfaces|protocols|routing-options|routing-instances|vlans|firewall|policy-options)\s*$/i, "deletes a whole configuration hierarchy"],
  [/^delete\s+interfaces\s+\S+\s*$/i, "deletes an interface's whole configuration"],
  [/^delete\s+protocols\s+\S+\s*$/i, "deletes a whole routing protocol"],
  [/^set\s+routing-options\s+static\s+route\s+0\.0\.0\.0\/0\b/i, "changes the default route"],
  [/^line\s+(vty|con|aux)/i, "changes management access lines"],
  [/^(ip\s+)?(access-class|transport\s+input)/i, "changes management access"],
  [/^no\s+(router|interface|vlan|ip\s+routing|ip\s+cef|spanning-tree|vrf)\b/i, "removes a routing, interface or switching object"],
  [/^(default\s+interface)\b/i, "wipes an interface's configuration"],
  [/^(spanning-tree\s+(mode|vlan|portfast\s+default))/i, "affects every port's loop protection"],
  [/^(ip\s+route\s+0\.0\.0\.0\s+0\.0\.0\.0|no\s+ip\s+route\s+0\.0\.0\.0)/i, "changes the default route"],
  [/^(hostname|ip\s+domain-name)\b/i, "renames the device, which can change its keys and identity in other systems"],
];

/** `platform` matters because the same word means different things: IOS `delete` erases a file, Junos `delete` removes configuration. */
export function assessLine(raw: string, platform: string = "ios"): LineAssessment {
  const line = raw.trim();
  if (!line) return { line, risk: "blocked", reason: "an empty line" };
  if (/[\r\n]/.test(raw)) return { line, risk: "blocked", reason: "one entry holds more than one line" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) return { line, risk: "blocked", reason: "contains control characters" };
  if (line.includes(";")) return { line, risk: "blocked", reason: "command chaining with ';'" };
  if (/(^|\s)\|\s*(redirect|tee|append)\b|>/.test(line)) return { line, risk: "blocked", reason: "redirects output" };
  if (platform === "junos") {
    if (!/^(set|delete)\s+\S/.test(line)) return { line, risk: "blocked", reason: "is not a Junos set or delete line" };
    // The Junos-specific blocks apply; the IOS file and mode commands do not, and would misread "delete" and "set".
    for (const [re, why] of BLOCKED.filter(([, w]) => /credential|operational/.test(w))) if (re.test(line)) return { line, risk: "blocked", reason: why };
  } else {
    for (const [re, why] of BLOCKED) if (re.test(line)) return { line, risk: "blocked", reason: why };
  }
  for (const [re, why] of HIGH) if (re.test(line)) return { line, risk: "high", reason: why };
  return { line, risk: "normal", reason: null };
}

export function assessLines(lines: string[], platform: string = "ios"): LineAssessment[] {
  return lines.map((l) => assessLine(l, platform));
}

export function blockedLines(lines: string[], platform: string = "ios"): LineAssessment[] {
  return assessLines(lines, platform).filter((a) => a.risk === "blocked");
}

/** Command output that means the device refused a line, across IOS, NX-OS and EOS. */
export const DEVICE_ERROR = /^\s*%\s|invalid (input|command)|incomplete command|ambiguous command|syntax error|unknown command|unrecognized command/im;
