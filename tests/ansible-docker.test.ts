import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { PlaybookError, groupByParent, renderPlaybook } from "@/lib/changes/playbook";
import type { Change } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { runDiagnostics } from "@/lib/diagnostics/engine";
import { InventoryError } from "@/lib/providers/inventory-file";
import { loadAnsibleInventory, parseAnsibleInventory } from "@/lib/providers/ansible-inventory";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { setContext } from "@/lib/server/context";
import { startStatefulDevice } from "./helpers/fake-device";

const ROOT = join(__dirname, "..");

const YAML_INV = `
all:
  vars:
    ansible_user: netops
    ansible_connection: network_cli
  hosts:
    stray: { ansible_network_os: ios, ansible_host: 10.5.5.5 }
  children:
    london:
      vars:
        tiny_snitch_environment: lab
      hosts:
        lon-r1: { ansible_host: 10.0.0.1, ansible_network_os: cisco.ios.ios }
        lon-sw1: { ansible_host: 10.0.0.2, ansible_network_os: ios, tiny_snitch_kind: l2switch }
      children:
        leafs:
          vars:
            ansible_user: leafadmin
          hosts:
            lon-eos1:
              ansible_host: 10.0.0.3
              ansible_network_os: arista.eos.eos
              ansible_connection: httpapi
              ansible_httpapi_validate_certs: false
              ansible_password: !vault |
                $ANSIBLE_VAULT;1.1;AES256
                3633626136386161
    paris:
      hosts:
        par-jun1: { ansible_network_os: junipernetworks.junos.junos, ansible_connection: ansible.netcommon.netconf, ansible_user: jadmin }
        par-nx1: { ansible_network_os: cisco.nxos.nxos, ansible_connection: ansible.netcommon.httpapi, ansible_httpapi_use_ssl: false }
        a-linux: { ansible_host: 10.9.9.9 }
`;

describe("Ansible inventory import", () => {
  const r = parseAnsibleInventory(YAML_INV);
  const site = (id: string) => r.inventory.sites.find((s) => s.id === id)!;
  const dev = (s: string, n: string) => site(s).devices.find((d) => d.name === n)!;

  it("makes each top-level group a network, with hosts from its child groups", () => {
    expect(r.inventory.sites.map((s) => s.id).sort()).toEqual(["london", "paris", "ungrouped"]);
    expect(site("london").devices.map((d) => d.name).sort()).toEqual(["lon-eos1", "lon-r1", "lon-sw1"]);
    expect(site("ungrouped").devices.map((d) => d.name)).toEqual(["stray"]);
  });

  it("maps network_os, connection, address and kind, and inherits variables from groups", () => {
    expect(dev("london", "lon-r1")).toMatchObject({ address: "10.0.0.1", platform: "ios", transport: "ssh", kind: "router" });
    expect(dev("london", "lon-sw1")).toMatchObject({ kind: "l2switch" });
    expect(dev("london", "lon-eos1")).toMatchObject({ platform: "eos", transport: "eapi", insecureTls: true });
    expect(dev("paris", "par-jun1")).toMatchObject({ platform: "junos", transport: "netconf" });
    expect(dev("paris", "par-nx1")).toMatchObject({ platform: "nxos", transport: "nxapi", address: "par-nx1" });
    // ansible_user from the leafs group beats the one from all; par-jun1 sets its own.
    const user = (d: { credential?: string }) => r.inventory.credentials[d.credential!].username;
    expect(user(dev("london", "lon-r1"))).toBe("netops");
    expect(user(dev("london", "lon-eos1"))).toBe("leafadmin");
    expect(user(dev("paris", "par-jun1"))).toBe("jadmin");
  });

  it("defaults to production, takes lab only when the group says so", () => {
    expect(site("london").environment).toBe("lab");
    expect(site("paris").environment).toBe("production");
    expect(site("ungrouped").environment).toBe("production");
  });

  it("never reads a password: vault values and ansible_password are ignored and said so", () => {
    const text = JSON.stringify(r.inventory);
    expect(text).not.toContain("ANSIBLE_VAULT");
    expect(text).not.toContain("3633626136386161");
    expect(r.warnings.join("\n")).toMatch(/Ignored ansible_password: passwords are never read from an inventory/);
    for (const c of Object.values(r.inventory.credentials)) expect(c.password).toBe("env:TS_ANSIBLE_PASSWORD");
  });

  it("skips what it cannot use and says why, instead of guessing", () => {
    expect(r.warnings.join("\n")).toMatch(/a-linux: skipped \(no ansible_network_os/);
    expect(r.warnings.join("\n")).toMatch(/par-nx1: ansible_httpapi_use_ssl is false; plain http is not supported, so https is used/);
    expect(r.warnings.join("\n")).toMatch(/lon-eos1: ansible_httpapi_validate_certs is false/);
  });

  it("accepts a password reference but rejects a literal password in tiny_snitch_password", () => {
    const ok = parseAnsibleInventory("all:\n  hosts:\n    r1: { ansible_network_os: ios, ansible_user: a, tiny_snitch_password: 'env:MY_PW' }\n");
    expect(Object.values(ok.inventory.credentials)[0].password).toBe("env:MY_PW");
    expect(() => parseAnsibleInventory("all:\n  hosts:\n    r1: { ansible_network_os: ios, ansible_user: a, tiny_snitch_password: hunter2 }\n")).toThrow(/no network devices Tiny Snitch can use/);
  });

  it("uses a private key file as a reference, not a password", () => {
    const k = parseAnsibleInventory("all:\n  hosts:\n    r1: { ansible_network_os: ios, ansible_user: a, ansible_ssh_private_key_file: /keys/id }\n");
    expect(Object.values(k.inventory.credentials)[0]).toEqual({ username: "a", privateKey: "file:/keys/id" });
  });

  it("reads the INI format, including [group:vars] and [all:vars]", () => {
    const ini = parseAnsibleInventory(`
[core]
r1 ansible_host=10.1.1.1 ansible_network_os=ios
r2 ansible_host=10.1.1.2 ansible_network_os=eos ansible_user=eosadmin

[core:vars]
ansible_connection=network_cli
tiny_snitch_environment=lab

[edge]
r3 ansible_host=10.1.2.1 ansible_network_os=junos ansible_connection=netconf

[all:vars]
ansible_user=ops
`);
    expect(ini.inventory.sites.map((s) => [s.id, s.environment, s.devices.length])).toEqual([["core", "lab", 2], ["edge", "production", 1]]);
    const cred = (s: string, n: string) => ini.inventory.credentials[ini.inventory.sites.find((x) => x.id === s)!.devices.find((d) => d.name === n)!.credential!].username;
    expect(cred("core", "r1")).toBe("ops");
    expect(cred("core", "r2")).toBe("eosadmin");
  });

  it("reads JSON, and links declared in tiny_snitch_links, ignoring links to unknown hosts", () => {
    const json = JSON.stringify({ all: { vars: { ansible_user: "u" }, children: { lab1: { vars: { tiny_snitch_environment: "lab", tiny_snitch_links: [{ a: "r1", aInterface: "Gi0/0", b: "r2", bInterface: "Gi0/0" }, { a: "r1", aInterface: "Gi0/1", b: "ghost", bInterface: "Gi0/0" }] }, hosts: { r1: { ansible_network_os: "ios" }, r2: { ansible_network_os: "ios" } } } } } });
    const j = parseAnsibleInventory(json);
    expect(j.inventory.sites[0].links).toHaveLength(1);
    expect(j.warnings.join()).toMatch(/1 entry in tiny_snitch_links did not name devices/);
  });

  it("treats an unknown environment as production", () => {
    const e = parseAnsibleInventory("all:\n  children:\n    g:\n      vars: { tiny_snitch_environment: staging, ansible_user: u }\n      hosts:\n        r1: { ansible_network_os: ios }\n");
    expect(e.inventory.sites[0].environment).toBe("production");
    expect(e.warnings.join()).toMatch(/must be lab or production/);
  });

  it("explains an inventory with nothing usable, and a file that is not YAML", () => {
    expect(() => parseAnsibleInventory("all:\n  hosts:\n    web1: { ansible_host: 10.0.0.9 }\n")).toThrow(/no network devices/);
    expect(() => parseAnsibleInventory("all: [unclosed")).toThrow(InventoryError);
    expect(() => loadAnsibleInventory(join(tmpdir(), "does-not-exist-inv.yml"))).toThrow(/could not be read/);
  });
});

describe("Ansible inventory as a network source", () => {
  let dev: { close: () => void } | null = null;
  afterEach(() => { dev?.close(); dev = null; setProviders(null); setContext(undefined); });
  const provider = (file: string) => new StaticProvider(file, "ansible", { kind: "ansible", label: "Ansible inventory", load: loadAnsibleInventory });

  it("lists networks as ansible:<group>, carrying the import warnings into the topology", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ts-ans-")), "inventory.yml");
    writeFileSync(file, YAML_INV);
    const p = provider(file);
    const scopes = await p.listScopes();
    expect(scopes.map((s) => [s.id, s.providerKind, s.environment])).toEqual(expect.arrayContaining([["ansible:london", "ansible", "lab"], ["ansible:paris", "ansible", "production"]]));
    const t = await p.getTopology("ansible:paris");
    expect(t.lab.providerId).toBe("ansible");
    expect(t.warnings.join()).toMatch(/Ignored ansible_password/);
  });

  it("runs diagnostics on a device taken from an Ansible inventory, with the password from the environment", async () => {
    const d = await startStatefulDevice({ host: "R1", config: "hostname R1\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n" });
    dev = d;
    process.env.TS_ANSIBLE_PASSWORD = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-ans-")), "inventory.yml");
    writeFileSync(file, `all:\n  vars: { ansible_user: admin }\n  children:\n    bench:\n      vars: { tiny_snitch_environment: lab }\n      hosts:\n        R1: { ansible_host: 127.0.0.1, ansible_port: ${d.port}, ansible_network_os: ios }\n`);
    setContext({ db: openDatabase(":memory:"), mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, llm: null, lastConnectAttempt: 0 });
    setProviders([provider(file)]);
    const { run } = await runDiagnostics("ansible:bench", { pings: false });
    expect(run.devices[0]).toMatchObject({ label: "R1", inspected: true, commandsFailed: 0 });
  });
});

const plan = (label: string, platform: "ios" | "eos" | "nxos" | "junos", commands: string[], risks: Change["plan"]["devices"][number]["risks"] = []): Change["plan"]["devices"][number] =>
  ({ deviceId: label, label, platform, commands, risks: risks.length ? risks : commands.map((line) => ({ line, risk: "normal" as const, reason: null })) });
const change = (devices: Change["plan"]["devices"], over: Partial<Change> = {}): Pick<Change, "id" | "title" | "intent" | "environment" | "plan" | "source"> =>
  ({ id: "c1", title: "Bring up uplink", intent: "second link", environment: "lab", source: "user", plan: { devices, warnings: [] }, ...over });

describe("Ansible playbook export", () => {
  const plays = (text: string) => parseYaml(text) as { name: string; hosts: string; gather_facts: boolean; collections?: string[]; tasks: Record<string, Record<string, unknown>>[] }[];

  it("groups flat commands under their interface and router parents", () => {
    expect(groupByParent(["hostname x", "interface Gi0/1", "description up", "no shutdown", "router bgp 65000", "address-family ipv4", "neighbor 10.0.0.2 activate", "interface Lo0"])).toEqual([
      { parents: [], lines: ["hostname x"] },
      { parents: ["interface Gi0/1"], lines: ["description up", "no shutdown"] },
      { parents: ["router bgp 65000", "address-family ipv4"], lines: ["neighbor 10.0.0.2 activate"] },
      { parents: [], lines: ["interface Lo0"] }, // a header with nothing under it is still sent
    ]);
  });

  it("uses each platform's config module and never lets Ansible save by itself", () => {
    const p = plays(renderPlaybook(change([plan("r1", "ios", ["interface Gi0/1", "no shutdown"]), plan("e1", "eos", ["interface Ethernet1", "no shutdown"]), plan("n1", "nxos", ["interface Ethernet1/1", "no shutdown"])])));
    expect(p.map((x) => [x.hosts, x.collections, Object.keys(x.tasks[0]).find((k) => k !== "name")])).toEqual([
      ["r1", ["cisco.ios"], "cisco.ios.ios_config"], ["e1", ["arista.eos"], "arista.eos.eos_config"], ["n1", ["cisco.nxos"], "cisco.nxos.nxos_config"],
    ]);
    expect(p[0].tasks[0]["cisco.ios.ios_config"]).toEqual({ parents: ["interface Gi0/1"], lines: ["no shutdown"], save_when: "never" });
    expect(p.every((x) => x.gather_facts === false)).toBe(true);
  });

  it("makes a Junos commit-confirmed task followed by a separate confirm task", () => {
    const p = plays(renderPlaybook(change([plan("j1", "junos", ["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description up"])])));
    expect(p[0].tasks).toHaveLength(2);
    expect(p[0].tasks[0]["junipernetworks.junos.junos_config"]).toMatchObject({ lines: ["delete interfaces ge-0/0/1 disable", "set interfaces ge-0/0/1 description up"], confirm: 10 });
    expect(p[0].tasks[1]["junipernetworks.junos.junos_config"]).toEqual({ confirm_commit: true });
  });

  it("says in the file what it does not protect, and flags production and high-risk lines", () => {
    const text = renderPlaybook(change([plan("r1", "ios", ["alias exec s show version"], [{ line: "alias exec s show version", risk: "high", reason: "redefines command names" }])], { environment: "production" }));
    expect(text).toMatch(/does NOT carry Tiny Snitch's protections/);
    expect(text).toMatch(/PRODUCTION NETWORK/);
    expect(text).toMatch(/High-risk lines[\s\S]*alias exec s show version/);
  });

  it("refuses a device name Ansible would read as a host pattern", () => {
    for (const bad of ["r1:r2", "r1,r2", "!r1", "all", "ALL", "r1 r2", "*", "&r1"]) {
      expect(() => renderPlaybook(change([plan(bad, "ios", ["description x"])])), bad).toThrow(PlaybookError);
    }
  });

  it("cannot be made to emit extra comment lines or tasks through the title or intent", () => {
    const text = renderPlaybook(change([plan("r1", "ios", ["description x"])], { title: "ok\n- hosts: all\n  tasks: []", intent: "x\n# injected" }));
    const lines = text.split("\n").filter((l) => l.startsWith("#"));
    expect(lines.some((l) => l.includes("injected") && !l.startsWith("# Intent:"))).toBe(false);
    expect(plays(text)).toHaveLength(1);
    expect(plays(text)[0].hosts).toBe("r1");
  });
});

describe("Docker and the app runner", () => {
  it("listens on APP_HOST (with a note when it is not loopback) and defaults to loopback", () => {
    const run = (env: Record<string, string>) => {
      const e: Record<string, string | undefined> = { ...process.env, RUN_NEXT_DRY: "1", ...env };
      if (!("APP_HOST" in env)) delete e.APP_HOST;
      return spawnSync(process.execPath, ["scripts/run-next.mjs", "start"], { cwd: ROOT, env: e as NodeJS.ProcessEnv, encoding: "utf8" });
    };
    const open = run({ APP_HOST: "0.0.0.0", APP_PORT: "3010" });
    expect(JSON.parse(open.stdout)).toMatchObject({ host: "0.0.0.0", port: "3010" });
    expect(open.stderr).toMatch(/stays closed until the first administrator/);
    const dflt = run({});
    expect(JSON.parse(dflt.stdout).host).toBe("127.0.0.1");
    expect(dflt.stderr).not.toMatch(/stays closed/);
  });

  const compose = parseYaml(readFileSync(join(ROOT, "compose.yaml"), "utf8")) as { services: Record<string, { ports: string[]; environment: Record<string, string>; cap_drop?: string[]; privileged?: boolean; network_mode?: string; security_opt?: string[] }> };
  const svc = compose.services["tiny-snitch"];

  it("publishes the port to the host's loopback only", () => {
    expect(svc.ports.length).toBeGreaterThan(0);
    for (const p of svc.ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
  });
  it("is not privileged, not on the host network, drops capabilities, and puts no secret in the file", () => {
    expect(svc.privileged).toBeUndefined();
    expect(svc.network_mode).toBeUndefined();
    expect(svc.cap_drop).toEqual(["ALL"]);
    expect(svc.security_opt).toContain("no-new-privileges:true");
    for (const k of Object.keys(svc.environment)) expect(k, k).not.toMatch(/KEY|TOKEN|PASSWORD|SECRET|AUTH/i);
  });
  it("builds a non-root image with a health check and no secrets baked in", () => {
    const df = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(df).toMatch(/^USER node$/m);
    expect(df).toMatch(/^HEALTHCHECK /m);
    expect(df).toMatch(/node:22/);
    expect(df).not.toMatch(/ANTHROPIC|API_KEY|PASSWORD|TOKEN|\.env\.local/i);
  });
  it("keeps secrets and local state out of the build context", () => {
    const ignore = readFileSync(join(ROOT, ".dockerignore"), "utf8").split(/\r?\n/);
    for (const entry of [".env", ".env.*", "data", "inventory.yaml", "node_modules", ".git"]) expect(ignore, entry).toContain(entry);
    expect(ignore).toContain("!.env.example");
  });
});
