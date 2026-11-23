import { hostKeyPem } from "./helpers/host-key";
import { type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Server, utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceRef } from "@/lib/core/types";
import { SshTransport, type SshTarget } from "@/lib/transport/ssh";

/** A tiny IOS-like CLI behind a real SSH server, so the transport is tested over a real SSH connection. */
const BRIEF = [
  "Interface              IP-Address      OK? Method Status                Protocol",
  "GigabitEthernet0/0     10.0.0.1        YES NVRAM  up                    up",
  "GigabitEthernet0/1     unassigned      YES NVRAM  administratively down down",
].join("\r\n");

type Fake = { port: number; close: () => void; sent: string[]; logins: number };

function startServer(opts: { password?: string; hostName?: string; pager?: boolean; publicKey?: string } = {}): Promise<Fake> {
  const password = opts.password ?? "secret";
  const host = opts.hostName ?? "R1";
  const hostKey = hostKeyPem();
  const sent: string[] = [];
  const fake: Fake = { port: 0, close: () => undefined, sent, logins: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && !opts.publicKey && ctx.username === "admin" && ctx.password === password) { fake.logins++; ctx.accept(); return; }
      if (ctx.method === "publickey" && opts.publicKey && ctx.username === "admin") {
        const trusted = utils.parseKey(opts.publicKey);
        const same = !(trusted instanceof Error) && ctx.key.algo === trusted.type && ctx.key.data.equals(trusted.getPublicSSH());
        if (!same) { ctx.reject(["publickey"]); return; }
        if (!ctx.signature) { ctx.accept(); return; } // the probe before the signed attempt
        if (trusted.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) { fake.logins++; ctx.accept(); } else ctx.reject(["publickey"]);
        return;
      }
      ctx.reject(opts.publicKey ? ["publickey"] : ["password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a());
      session.on("shell", (a) => {
        const stream = a();
        let mode: "exec" | "config" = "exec";
        const prompt = () => `${host}${mode === "config" ? "(config)" : ""}#`;
        stream.write(`\r\nWelcome\r\n${prompt()}`);
        let buf = "";
        stream.on("data", (d: Buffer) => {
          if (opts.pager && d.toString() === " ") { stream.write(`\r\n${BRIEF.split("\r\n").slice(1).join("\r\n")}\r\n${prompt()}`); return; } // the space that pages on
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            sent.push(line);
            let out = "";
            if (line === "configure terminal") mode = "config";
            else if (line === "end") mode = "exec";
            else if (mode === "config") { if (/^bogus/.test(line)) out = "% Invalid input detected at '^' marker."; }
            else if (line === "show ip interface brief") out = opts.pager ? `${BRIEF.split("\r\n")[0]}\r\n --More-- ` : BRIEF;
            else if (line === "show running-config") out = "hostname R1\r\nenable secret 5 $1$abcd$abcdefghijklmnop\r\n";
            else if (line.startsWith("terminal") || line === "write memory") out = line === "write memory" ? "Building configuration...\r\n[OK]" : "";
            else if (line.startsWith("show")) out = "% Invalid input detected at '^' marker.";
            if (opts.pager && line === "show ip interface brief") { stream.write(`${line}\r\n${out}`); continue; } // paused at --More--, no prompt yet
            stream.write(`${line}\r\n${out ? `${out}\r\n` : ""}${prompt()}`);
          }
        });
      });
    }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    fake.port = (server.address() as AddressInfo).port;
    fake.close = () => server.close();
    resolve(fake);
  }));
}

const dev: DeviceRef = { id: "d1", label: "R1", kind: "router", platform: "ios" };
const memStore = () => { const m = new Map<string, string>(); return { m, get: (i: string) => m.get(i) ?? null, set: (i: string, f: string) => void m.set(i, f) }; };
const target = (port: number, over: Partial<SshTarget> = {}): SshTarget => ({ label: "R1", host: "127.0.0.1", port, username: "admin", password: "env:TEST_PW", ...over });

let fake: Fake;
let transport: SshTransport;
let store: ReturnType<typeof memStore>;
const env: Record<string, string | undefined> = { TEST_PW: "secret" };
const make = (over: Partial<SshTarget> = {}) => new SshTransport(() => target(fake.port, over), { hostKeys: store, env, connectTimeoutMs: 5000, commandTimeoutMs: 5000 });

beforeEach(async () => { fake = await startServer(); store = memStore(); transport = make(); });
afterEach(() => { transport.closeAll(); fake.close(); });

describe("SSH transport", () => {
  it("runs a read-only command and returns the device's output without echo or prompt", async () => {
    const r = await transport.run(dev, "show ip interface brief");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("GigabitEthernet0/0     10.0.0.1");
    expect(r.text).not.toMatch(/R1#/);
    expect(r.text).not.toContain("show ip interface brief");
  });

  it("turns the pager off before anything else and reuses one login for several commands", async () => {
    await transport.run(dev, "show ip interface brief");
    await transport.run(dev, "show running-config");
    expect(fake.sent.slice(0, 2)).toEqual(["terminal length 0", "terminal width 0"]);
    expect(fake.logins).toBe(1);
  });

  it("masks secrets in what it returns", async () => {
    const r = await transport.run(dev, "show running-config");
    expect(r.text).toContain("hostname R1");
    expect(r.text).not.toContain("$1$abcd$abcdefghijklmnop");
  });

  it("refuses anything that is not show, ping or traceroute, before it reaches the device", async () => {
    for (const bad of ["configure terminal", "reload", "show version; reload", "show run > flash:x", "show ip route\nreload"]) {
      const r = await transport.run(dev, bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(fake.sent).not.toContain("reload");
    expect(fake.sent).not.toContain("configure terminal");
  });

  it("serves commands for one device strictly in order", async () => {
    const [a, b] = await Promise.all([transport.run(dev, "show ip interface brief"), transport.run(dev, "show running-config")]);
    expect(a.text).toContain("GigabitEthernet0/0");
    expect(b.text).toContain("hostname R1");
  });

  it("reports a wrong password as a login failure, never a hang", async () => {
    transport.closeAll();
    const bad = new SshTransport(() => target(fake.port), { hostKeys: store, env: { TEST_PW: "wrong" }, connectTimeoutMs: 5000 });
    const r = await bad.run(dev, "show ip interface brief");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/login was refused/);
    expect(r.text).not.toContain("wrong");
  });

  it("reports an unreachable device plainly", async () => {
    const down = new SshTransport(() => target(1), { hostKeys: store, env, connectTimeoutMs: 3000 });
    const r = await down.run(dev, "show ip interface brief");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not reachable|timed out/);
  });

  it("reports a missing credential without connecting", async () => {
    const t = new SshTransport(() => target(fake.port), { hostKeys: store, env: {}, connectTimeoutMs: 3000 });
    const r = await t.run(dev, "show ip interface brief");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/TEST_PW is not set/);
    expect(fake.logins).toBe(0);
  });

  it("remembers a host key on first contact and refuses a changed one", async () => {
    await transport.run(dev, "show running-config");
    expect([...store.m.keys()]).toEqual([`127.0.0.1:${fake.port}`]);
    transport.closeAll();
    const other = await startServer();
    store.m.set(`127.0.0.1:${other.port}`, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); // a different key is on record
    const t = new SshTransport(() => target(other.port), { hostKeys: store, env, connectTimeoutMs: 5000 });
    const r = await t.run(dev, "show running-config");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/host key changed/);
    t.closeAll(); other.close();
  });

  it("refuses a device whose key does not match the pinned fingerprint", async () => {
    transport.closeAll();
    const t = make({ hostKey: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" });
    const r = await t.run(dev, "show running-config");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/pinned fingerprint/);
    t.closeAll();
  });

  it("applies configuration lines in config mode and leaves it again", async () => {
    const r = await transport.push(dev, ["interface GigabitEthernet0/1", "description uplink", "no shutdown"]);
    expect(r).toMatchObject({ ok: true, applied: ["interface GigabitEthernet0/1", "description uplink", "no shutdown"], failedAt: null });
    const sent = fake.sent;
    expect(sent.indexOf("configure terminal")).toBeLessThan(sent.indexOf("description uplink"));
    expect(sent.at(-1)).toBe("end");
  });

  it("stops at the first line the device rejects and says which", async () => {
    const r = await transport.push(dev, ["interface GigabitEthernet0/1", "bogus thing", "description never sent"]);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe("bogus thing");
    expect(r.applied).toEqual(["interface GigabitEthernet0/1"]);
    expect(fake.sent).not.toContain("description never sent");
    expect(fake.sent.at(-1)).toBe("end"); // still leaves config mode
  });

  it("never sends blocked commands, even in a push", async () => {
    for (const bad of ["reload", "write erase", "crypto key zeroize rsa", "copy tftp: running-config", "interface Gi0/1\nshutdown"]) {
      const r = await transport.push(dev, [bad]);
      expect(r.ok, bad).toBe(false);
      expect(r.text).toMatch(/Refused before sending anything/);
    }
    expect(fake.sent).toEqual([]);
  });

  it("saves the configuration only when asked", async () => {
    await transport.push(dev, ["description x"]);
    expect(fake.sent).not.toContain("write memory");
    const r = await transport.save(dev);
    expect(r.ok).toBe(true);
    expect(fake.sent).toContain("write memory");
  });

  it("answers a --More-- pager instead of hanging", async () => {
    transport.closeAll(); fake.close();
    fake = await startServer({ pager: true });
    transport = make();
    const r = await transport.run(dev, "show ip interface brief");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("GigabitEthernet0/1");
  });
});

describe("SSH transport, key login", () => {
  let dir: string;
  let keyed: Fake;
  const pair = (passphrase?: string) => utils.generateKeyPairSync("ed25519", passphrase ? { passphrase, cipher: "aes256-ctr", rounds: 16 } : undefined);
  const write = (name: string, text: string) => { const f = join(dir, name); writeFileSync(f, text, { mode: 0o600 }); return f.split(sep).join("/"); };
  const run = (t: Partial<SshTarget>, e: Record<string, string | undefined> = {}) => {
    const tr = new SshTransport(() => ({ label: "R1", host: "127.0.0.1", port: keyed.port, username: "admin", ...t }), { hostKeys: memStore(), env: e, connectTimeoutMs: 5000, commandTimeoutMs: 5000 });
    return tr.run(dev, "show ip interface brief").finally(() => tr.closeAll());
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-key-")); });
  afterEach(() => { keyed?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("logs in with a private key from a file, with no password at all", async () => {
    const k = pair();
    keyed = await startServer({ publicKey: k.public });
    const r = await run({ privateKey: `file:${write("id", k.private)}` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("GigabitEthernet0/0     10.0.0.1");
    expect(keyed.logins).toBe(1);
  });

  it("logs in with a passphrase-protected key when the passphrase is given by reference", async () => {
    const k = pair("correct horse");
    keyed = await startServer({ publicKey: k.public });
    const r = await run({ privateKey: `file:${write("id", k.private)}`, passphrase: "env:KEY_PASS" }, { KEY_PASS: "correct horse" });
    expect(r.ok).toBe(true);
    expect(keyed.logins).toBe(1);
  });

  it("fails clearly, without exposing the passphrase, when the passphrase is wrong or missing", async () => {
    const k = pair("correct horse");
    keyed = await startServer({ publicKey: k.public });
    const f = `file:${write("id", k.private)}`;
    for (const t of [{ privateKey: f, passphrase: "env:KEY_PASS" }, { privateKey: f }]) {
      const r = await run(t, { KEY_PASS: "wrong one" });
      expect(r.ok).toBe(false);
      expect(r.text).not.toContain("wrong one");
      expect(r.text).not.toContain("correct horse");
    }
    expect(keyed.logins).toBe(0);
  });

  it("reports a key the device does not trust as a refused login", async () => {
    keyed = await startServer({ publicKey: pair().public });
    const r = await run({ privateKey: `file:${write("other", pair().private)}` });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/login was refused/);
    expect(keyed.logins).toBe(0);
  });

  it("says so when the key file does not exist", async () => {
    keyed = await startServer({ publicKey: pair().public });
    const r = await run({ privateKey: `file:${join(dir, "missing").split(sep).join("/")}` });
    expect(r.ok).toBe(false);
    expect(r.text).not.toMatch(/login was refused/);
  });
});
