import { hostKeyPem } from "./host-key";
import { type AddressInfo } from "node:net";
import { Server } from "ssh2";

/** A scripted CLI behind a real SSH server. `answers` maps an exact command to its output; config lines are recorded. */
export type FakeDevice = { port: number; close: () => void; sent: string[]; config: string[] };

export function startFakeDevice(opts: { host: string; answers: Record<string, string>; password?: string }): Promise<FakeDevice> {
  const hostKey = hostKeyPem();
  const dev: FakeDevice = { port: 0, close: () => undefined, sent: [], config: [] };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "admin" && ctx.password === (opts.password ?? "secret") ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a());
      session.on("shell", (a) => {
        const stream = a();
        let mode: "exec" | "config" = "exec";
        const prompt = () => `${opts.host}${mode === "config" ? "(config)" : ""}#`;
        stream.write(`\r\n${prompt()}`);
        let buf = "";
        stream.on("data", (d: Buffer) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            dev.sent.push(line);
            let out = "";
            if (line === "configure terminal") mode = "config";
            else if (line === "end") mode = "exec";
            else if (mode === "config") dev.config.push(line);
            else if (line.startsWith("terminal") || line.startsWith("set cli")) out = "";
            else if (line in opts.answers) out = opts.answers[line];
            else if (line.startsWith("ping ")) out = "Success rate is 100 percent (2/2), round-trip min/avg/max = 1/1/2 ms";
            else out = "% Invalid input detected at '^' marker.";
            stream.write(`${line}\r\n${out ? `${out.replace(/\n/g, "\r\n")}\r\n` : ""}${prompt()}`);
          }
        });
      });
    }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    dev.port = (server.address() as AddressInfo).port;
    dev.close = () => server.close();
    resolve(dev);
  }));
}

export const brief = (rows: [string, string, string, string][]) =>
  ["Interface              IP-Address      OK? Method Status                Protocol", ...rows.map(([n, ip, s, p]) => `${n.padEnd(22)} ${ip.padEnd(15)} YES NVRAM  ${s.padEnd(21)} ${p}`)].join("\n");

// ---- a device that really holds configuration ------------------------------------------------------------

const EXPAND: Record<string, string> = { gi: "GigabitEthernet", fa: "FastEthernet", lo: "Loopback", eth: "Ethernet" };
const expandIf = (n: string) => n.replace(/^(gi|fa|lo|eth)(?=\d)/i, (m) => EXPAND[m.toLowerCase()]);
const HEADER = /^(interface|router|vlan|line|ip access-list)\b/i;

export type StatefulDevice = FakeDevice & { text: () => string; blocks: Map<string, string[]>; reject: Set<string>; failShow: { on: boolean } };

/** Parses a starting configuration written the way IOS prints it. */
function load(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>([["", []]]);
  let cur = "";
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim() === "!") { cur = ""; continue; }
    if (/^\s/.test(raw)) { blocks.get(cur)!.push(raw.trim()); continue; }
    if (HEADER.test(raw)) { cur = raw.trim().replace(/^interface\s+(\S+)$/i, (_m, n) => `interface ${expandIf(n)}`); if (!blocks.has(cur)) blocks.set(cur, []); } else { cur = ""; blocks.get("")!.push(raw.trim()); }
  }
  return blocks;
}

function render(blocks: Map<string, string[]>): string {
  const out = ["Building configuration...", "", "Current configuration : 1234 bytes", "!"];
  for (const l of blocks.get("") ?? []) out.push(l, "!");
  for (const [k, v] of blocks) if (k) { out.push(k, ...v.map((l) => ` ${l}`), "!"); }
  out.push("end");
  return out.join("\n");
}

function briefOf(blocks: Map<string, string[]>): string {
  const rows: [string, string, string, string][] = [];
  for (const [k, v] of blocks) {
    const m = k.match(/^interface (\S+)$/);
    if (!m) continue;
    const ip = v.find((l) => l.startsWith("ip address "))?.split(" ")[2] ?? "unassigned";
    const down = v.includes("shutdown");
    rows.push([m[1], ip, down ? "administratively down" : "up", down ? "down" : "up"]);
  }
  return brief(rows);
}

export function startStatefulDevice(opts: { host: string; config: string; password?: string; reject?: string[]; ignore?: string[] }): Promise<StatefulDevice> {
  const blocks = load(opts.config);
  const reject = new Set(opts.reject ?? []);
  const failShow = { on: false };
  const answers = new Proxy({} as Record<string, string>, {
    has: (_t, p) => typeof p === "string" && (p === "show running-config" || p === "show ip interface brief" || p === "show ip ospf neighbor" || p === "show ip bgp summary" || p === "write memory"),
    get: (_t, p) => {
      if (failShow.on && p === "show running-config") return "% Invalid input detected at '^' marker.";
      return p === "show running-config" ? render(blocks) : p === "show ip interface brief" ? briefOf(blocks) : p === "show ip ospf neighbor" ? "" : p === "write memory" ? "Building configuration...\n[OK]" : "% BGP not active";
    },
  });
  const hostKey = hostKeyPem();
  const dev = { port: 0, close: () => undefined, sent: [] as string[], config: [] as string[], text: () => render(blocks), blocks, reject, failShow } as StatefulDevice;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "admin" && ctx.password === (opts.password ?? "secret") ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a());
      session.on("shell", (a) => {
        const stream = a();
        let mode: "exec" | "config" = "exec";
        let ctxKey = "";
        const prompt = () => `${opts.host}${mode === "config" ? "(config)" : ""}#`;
        stream.write(`\r\n${prompt()}`);
        let buf = "";
        stream.on("data", (d: Buffer) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            dev.sent.push(line);
            let out = "";
            if (mode === "exec") {
              if (line === "configure terminal") mode = "config";
              else if (line.startsWith("terminal")) out = "";
              else if (line in answers) out = answers[line];
              else if (line.startsWith("ping ")) out = "Success rate is 100 percent (2/2), round-trip min/avg/max = 1/1/2 ms";
              else out = "% Invalid input detected at '^' marker.";
            } else if (line === "end") { mode = "exec"; ctxKey = ""; }
            else if (reject.has(line) || /^bogus/.test(line)) out = "% Invalid input detected at '^' marker.";
            else if (opts.ignore?.includes(line)) dev.config.push(line); // accepted, but silently not applied
            else {
              dev.config.push(line);
              let m: RegExpMatchArray | null;
              if ((m = line.match(/^no\s+(interface|router|vlan)\s+(.+)$/i))) {
                blocks.delete(m[1].toLowerCase() === "interface" ? `interface ${expandIf(m[2])}` : `${m[1].toLowerCase()} ${m[2]}`);
                ctxKey = "";
              } else if (HEADER.test(line)) {
                ctxKey = line.replace(/\s+/g, " ").replace(/^interface (\S+)$/i, (_x, n) => `interface ${expandIf(n)}`);
                if (!blocks.has(ctxKey)) blocks.set(ctxKey, []);
              } else {
                const cur = blocks.get(ctxKey) ?? blocks.get("")!;
                if ((m = line.match(/^no\s+(.+)$/i))) {
                  const x = m[1];
                  const i = cur.findIndex((l) => l === x || l.startsWith(`${x} `));
                  if (i >= 0) cur.splice(i, 1);
                } else {
                  const key = /^(ip address|description|hostname|router-id|mtu)\b/.exec(line)?.[1];
                  const i = key ? cur.findIndex((l) => l === key || l.startsWith(`${key} `)) : cur.indexOf(line);
                  if (i >= 0) cur[i] = line; else cur.push(line);
                }
              }
            }
            stream.write(`${line}\r\n${out ? `${out.replace(/\n/g, "\r\n")}\r\n` : ""}${prompt()}`);
          }
        });
      });
    }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    dev.port = (server.address() as AddressInfo).port;
    dev.close = () => server.close();
    resolve(dev);
  }));
}
