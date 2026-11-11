import { hostKeyPem } from "./host-key";
import http from "node:http";
import { type AddressInfo } from "node:net";
import { Server } from "ssh2";

/** Configuration state shared by the HTTP fakes: IOS-style indented blocks with enough behaviour for a change to be applied and undone. */
const EXPAND: Record<string, string> = { gi: "GigabitEthernet", eth: "Ethernet", lo: "Loopback" };
const expandIf = (n: string) => n.replace(/^(gi|eth|lo)(?=\d)/i, (m) => EXPAND[m.toLowerCase()]);
const HEADER = /^(interface|router|vlan|line|ip access-list)\b/i;

export class FakeConfig {
  blocks = new Map<string, string[]>([["", []]]);
  private ctx = "";
  constructor(text: string, public style: "eos" | "nxos" = "eos") {
    let cur = "";
    for (const raw of text.split("\n")) {
      if (!raw.trim() || raw.trim() === "!") { cur = ""; continue; }
      if (/^\s/.test(raw)) { this.blocks.get(cur)!.push(raw.trim()); continue; }
      if (HEADER.test(raw)) { cur = raw.trim().replace(/^interface\s+(\S+)$/i, (_m, n) => `interface ${expandIf(n)}`); if (!this.blocks.has(cur)) this.blocks.set(cur, []); } else { cur = ""; this.blocks.get("")!.push(raw.trim()); }
    }
  }
  /** Applies one configuration line. Returns an error message if the device would refuse it. */
  apply(line: string): string | null {
    if (/^bogus/.test(line)) return "% Invalid input detected at '^' marker.";
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^no\s+(interface|router|vlan)\s+(.+)$/i))) { this.blocks.delete(m[1].toLowerCase() === "interface" ? `interface ${expandIf(m[2])}` : `${m[1].toLowerCase()} ${m[2]}`); this.ctx = ""; return null; }
    if (HEADER.test(line)) { this.ctx = line.replace(/\s+/g, " ").replace(/^interface (\S+)$/i, (_x, n) => `interface ${expandIf(n)}`); if (!this.blocks.has(this.ctx)) this.blocks.set(this.ctx, []); return null; }
    const cur = this.blocks.get(this.ctx) ?? this.blocks.get("")!;
    if ((m = line.match(/^no\s+(.+)$/i))) { const i = cur.findIndex((l) => l === m![1] || l.startsWith(`${m![1]} `)); if (i >= 0) cur.splice(i, 1); return null; }
    const key = /^(ip address|description|hostname|router-id|mtu)\b/.exec(line)?.[1];
    const i = key ? cur.findIndex((l) => l === key || l.startsWith(`${key} `)) : cur.indexOf(line);
    if (i >= 0) cur[i] = line; else cur.push(line);
    return null;
  }
  endConfig() { this.ctx = ""; }
  render(): string {
    const out = ["! Command: show running-config", "!"];
    for (const l of this.blocks.get("") ?? []) out.push(l, "!");
    for (const [k, v] of this.blocks) if (k) out.push(k, ...v.map((l) => `   ${l}`), "!");
    out.push("end");
    return out.join("\n");
  }
  brief(): string {
    const ifs = [...this.blocks].filter(([k]) => /^interface /.test(k));
    const row = (name: string, lines: string[]) => {
      const ipTok = lines.find((l) => l.startsWith("ip address "))?.split(" ")[2];
      const ip = ipTok ?? "unassigned";
      const down = lines.includes("shutdown");
      return { name, ip, down };
    };
    if (this.style === "nxos") {
      return ["IP Interface Status for VRF \"default\"(1)", "Interface            IP Address      Interface Status", ...ifs.map(([k, v]) => { const r = row(k.replace("interface ", ""), v); return `${r.name.padEnd(20)} ${r.ip.split("/")[0].padEnd(15)} ${r.down ? "protocol-down/link-down/admin-down" : "protocol-up/link-up/admin-up"}`; })].join("\n");
    }
    return ["                                                                    Address", "Interface         IP Address         Status       Protocol           MTU Owner", "----------------- ------------------ ------------ -------------- ---------- -------",
      ...ifs.map(([k, v]) => { const r = row(k.replace("interface ", ""), v); return `${r.name.padEnd(17)} ${r.ip.padEnd(18)} ${(r.down ? "admin down" : "up").padEnd(12)} ${(r.down ? "down" : "up").padEnd(14)} 1500`; })].join("\n");
  }
}

export type Listening = { port: number; close: () => void };

const listen = (server: http.Server): Promise<Listening> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })));

const authOk = (req: http.IncomingMessage, user: string, pass: string) => req.headers.authorization === `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

// ---- Arista eAPI ------------------------------------------------------------------------------------------------
export type FakeEapi = Listening & { cfg: FakeConfig; requests: string[][]; ignore: Set<string> };

export async function startEapi(opts: { config: string; user?: string; pass?: string }): Promise<FakeEapi> {
  const cfg = new FakeConfig(opts.config, "eos");
  const requests: string[][] = [];
  const ignore = new Set<string>();
  const server = http.createServer(async (req, res) => {
    if (!authOk(req, opts.user ?? "admin", opts.pass ?? "secret")) { res.writeHead(401); return res.end("{}"); }
    if (req.url !== "/command-api") { res.writeHead(404); return res.end("{}"); }
    const body = JSON.parse(await readBody(req)) as { params: { cmds: string[] }; id: string };
    const cmds = body.params.cmds;
    requests.push(cmds);
    const result: { output?: string; errors?: string[] }[] = [];
    let config = false;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      let out = "";
      if (c === "enable") out = "";
      else if (c === "configure") config = true;
      else if (c === "end") { config = false; cfg.endConfig(); }
      else if (config) {
        if (ignore.has(c)) { result.push({ output: "" }); continue; }
        const err = cfg.apply(c);
        if (err) { result.push({ errors: [err] }); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 1002, message: `CLI command ${i + 1} of ${cmds.length} '${c}' failed: invalid command`, data: [...result, ...cmds.slice(i + 1).map(() => ({}))] } })); }
      } else if (c === "show running-config") out = cfg.render();
      else if (c === "show ip interface brief") out = cfg.brief();
      else if (c === "show ip ospf neighbor" || c === "show ip bgp summary") out = "";
      else if (c === "write memory") out = "Copy completed successfully.";
      else if (c.startsWith("ping ")) out = "PING 10.0.0.2: 5 packets transmitted, 5 received, 0% packet loss, time 4ms";
      else { result.push({ errors: ["Invalid input"] }); res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 1002, message: `CLI command ${i + 1} '${c}' failed: invalid command`, data: result } })); }
      result.push({ output: out });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  return Object.assign(await listen(server), { cfg, requests, ignore });
}

// ---- Cisco NX-API ----------------------------------------------------------------------------------------------
export type FakeNxapi = Listening & { cfg: FakeConfig; requests: { type: string; input: string }[]; ignore: Set<string> };

export async function startNxapi(opts: { config: string; user?: string; pass?: string }): Promise<FakeNxapi> {
  const cfg = new FakeConfig(opts.config, "nxos");
  const requests: { type: string; input: string }[] = [];
  const ignore = new Set<string>();
  const server = http.createServer(async (req, res) => {
    if (!authOk(req, opts.user ?? "admin", opts.pass ?? "secret")) { res.writeHead(401); return res.end("{}"); }
    if (req.url !== "/ins") { res.writeHead(404); return res.end("{}"); }
    const { ins_api } = JSON.parse(await readBody(req)) as { ins_api: { type: string; input: string } };
    requests.push({ type: ins_api.type, input: ins_api.input });
    const inputs = ins_api.input.split(" ;").map((s) => s.trim()).filter(Boolean);
    const outs: { input: string; msg: string; code: string; body: string }[] = [];
    for (const input of inputs) {
      if (ins_api.type === "cli_conf") {
        if (ignore.has(input)) { outs.push({ input, msg: "Success", code: "200", body: "" }); continue; }
        const err = cfg.apply(input);
        outs.push(err ? { input, msg: "Invalid command", code: "400", body: "" } : { input, msg: "Success", code: "200", body: "" });
        if (err) break;
      } else {
        const body = input === "show running-config" ? cfg.render() : input === "show ip interface brief" ? cfg.brief() : input === "show ip ospf neighbors" || input === "show ip bgp summary" || input === "show vlan brief" ? "" : input === "copy running-config startup-config" ? "[########################################] 100%\nCopy complete." : input.startsWith("ping ") ? "5 packets transmitted, 5 packets received, 0.00% packet loss" : null;
        outs.push(body === null ? { input, msg: "Invalid command", code: "400", body: "" } : { input, msg: "Success", code: "200", body });
      }
    }
    cfg.endConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ins_api: { version: "1.0", type: ins_api.type, sid: "eoc", outputs: { output: outs.length === 1 ? outs[0] : outs } } }));
  });
  return Object.assign(await listen(server), { cfg, requests, ignore });
}

// ---- Junos over NETCONF -----------------------------------------------------------------------------------------
export type FakeJunos = {
  port: number; close: () => void;
  committed: Set<string>; candidate: Set<string>;
  /** A "commit confirmed" is pending: the device would revert it when the timer ends unless it is confirmed. */
  pending: boolean; rpcs: string[]; locked: boolean; ignore: Set<string>;
  revertPending: () => void;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const EOM = "]]>]]>";

function terse(sets: Set<string>): string {
  const names = new Set<string>();
  for (const l of sets) { const m = l.match(/^set interfaces (\S+) /); if (m) names.add(m[1]); }
  const out = ["Interface               Admin Link Proto    Local                 Remote"];
  for (const n of [...names].sort()) {
    const down = sets.has(`set interfaces ${n} disable`);
    out.push(`${n.padEnd(23)} ${down ? "down" : "up  "}  ${down ? "down" : "up  "}`);
    const addr = [...sets].find((l) => l.startsWith(`set interfaces ${n} unit 0 family inet address `))?.split(" ").pop();
    if (addr) out.push(`${(`${n}.0`).padEnd(23)} ${down ? "down" : "up  "}  ${down ? "down" : "up  "} inet     ${addr}`);
  }
  return out.join("\n");
}

export function startJunos(opts: { config: string[]; user?: string; pass?: string }): Promise<FakeJunos> {
  const hostKey = hostKeyPem();
  const dev: FakeJunos = { port: 0, close: () => undefined, committed: new Set(opts.config), candidate: new Set(opts.config), pending: false, rpcs: [], locked: false, ignore: new Set(), revertPending: () => undefined };
  let beforePending: Set<string> | null = null;
  dev.revertPending = () => { if (dev.pending && beforePending) { dev.committed = new Set(beforePending); dev.candidate = new Set(beforePending); dev.pending = false; } };

  const reply = (inner: string) => `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">${inner}</rpc-reply>${EOM}`;
  const error = (msg: string, bad?: string) => reply(`<rpc-error><error-severity>error</error-severity><error-message>${esc(msg)}</error-message>${bad ? `<error-info><bad-element>${esc(bad)}</bad-element></error-info>` : ""}</rpc-error>`);

  const handle = (xml: string): string => {
    dev.rpcs.push(xml);
    let m: RegExpMatchArray | null;
    if ((m = xml.match(/<command format="text">([\s\S]*?)<\/command>/))) {
      const c = unesc(m[1]).trim();
      const out = c === "show configuration | display set" ? [...dev.committed].join("\n")
        : c === "show interfaces terse" ? terse(dev.committed)
        : c === "show ospf neighbor" ? ""
        : c === "show bgp summary" ? "BGP is not running"
        : c.startsWith("ping ") ? "--- 10.0.0.2 ping statistics ---\n2 packets transmitted, 2 packets received, 0% packet loss"
        : null;
      return out === null ? error("syntax error, expecting <command>", c) : reply(`<output>${esc(out)}</output>`);
    }
    if (xml.includes("<lock>")) { if (dev.locked) return error("configuration database is locked"); dev.locked = true; return reply("<ok/>"); }
    if (xml.includes("<unlock>")) { dev.locked = false; return reply("<ok/>"); }
    if ((m = xml.match(/<configuration-set>([\s\S]*?)<\/configuration-set>/))) {
      for (const raw of unesc(m[1]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (dev.ignore.has(raw)) continue;
        if (/^set\s+bogus|^delete\s+bogus/.test(raw)) return error("syntax error", raw);
        if (raw.startsWith("set ")) dev.candidate.add(raw);
        else if (raw.startsWith("delete ")) { const p = `set ${raw.slice(7)}`; for (const l of [...dev.candidate]) if (l === p || l.startsWith(`${p} `)) dev.candidate.delete(l); }
        else return error("syntax error", raw);
      }
      return reply("<load-success/>");
    }
    if (xml.includes("<commit-configuration><check/>")) return reply("<ok/>");
    if (xml.includes("<confirmed/>")) { beforePending = new Set(dev.committed); dev.committed = new Set(dev.candidate); dev.pending = true; return reply("<ok/>"); }
    if (xml.includes("<commit-configuration")) { dev.committed = new Set(dev.candidate); dev.pending = false; beforePending = null; return reply("<ok/>"); }
    if (xml.includes("<discard-changes/>")) { dev.candidate = new Set(dev.committed); return reply("<ok/>"); }
    return error("unknown rpc");
  };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === (opts.user ?? "admin") && ctx.password === (opts.pass ?? "secret") ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("subsystem", (acc, _rej, info) => {
        if (info.name !== "netconf") return;
        const stream = acc();
        stream.write(`<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities><session-id>1</session-id></hello>${EOM}`);
        let buf = "";
        stream.on("data", (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf(EOM)) >= 0) {
            const msg = buf.slice(0, i);
            buf = buf.slice(i + EOM.length);
            if (msg.includes("<hello")) continue;
            stream.write(handle(msg));
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
