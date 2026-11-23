import { checkReadOnlyCommand } from "../assistant/policy";
import { blockedLines } from "../core/safety";
import { resolveSecret, type Env } from "../core/secrets";
import type { CommandOutcome, DeviceRef, DeviceTransport, PushOutcome } from "../core/types";
import { redactSecrets } from "../security/redact";
import { ApiError, type ApiTarget, postJson } from "./http";

/**
 * Cisco NX-API: JSON over HTTPS to /ins. `cli_show_ascii` returns the text a `show` command prints; `cli_conf` takes
 * configuration lines joined with " ;". Written from Cisco's documented NX-API CLI; tested against a faithful
 * in-process server, not a real Nexus.
 */
type Out = { input?: string; msg?: string; code?: string | number; body?: unknown };
type Reply = { ins_api?: { outputs?: { output?: Out | Out[] } } };

const asList = (o: Out | Out[] | undefined): Out[] => (o === undefined ? [] : Array.isArray(o) ? o : [o]);
const ok = (o: Out) => String(o.code) === "200";

export class NxapiTransport implements DeviceTransport {
  readonly kind = "nxapi" as const;
  constructor(private targetFor: (d: DeviceRef) => ApiTarget | null, private env: Env = process.env) {}

  private async call(d: DeviceRef, type: "cli_show_ascii" | "cli_conf", input: string): Promise<Out[]> {
    const t = this.targetFor(d);
    if (!t) throw new ApiError(`${d.label}: no NX-API address or credential is known for this device.`, "config");
    let password: string;
    try { password = resolveSecret(t.password, this.env); } catch (e) { throw new ApiError(e instanceof Error ? e.message : "A credential could not be read.", "config"); }
    const r = (await postJson(t, "/ins", { ins_api: { version: "1.0", type, chksum: "0", sid: "sid", input, output_format: "json" } }, { password })) as Reply;
    const outs = asList(r.ins_api?.outputs?.output);
    if (!outs.length) throw new ApiError(`${d.label}: NX-API returned no output.`, "http");
    return outs;
  }

  async run(device: DeviceRef, command: string): Promise<CommandOutcome> {
    const check = checkReadOnlyCommand(command);
    if (!check.ok) return { ok: false, text: check.reason };
    try {
      const [o] = await this.call(device, "cli_show_ascii", command.trim());
      if (!ok(o)) return { ok: false, text: redactSecrets(`${o.msg ?? "The switch refused the command."}`) };
      return { ok: true, text: redactSecrets(typeof o.body === "string" ? o.body.replace(/\s+$/, "") : o.body ? JSON.stringify(o.body) : "") };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  pushSupport(d: DeviceRef) {
    return d.platform === "nxos" ? ({ ok: true } as const) : ({ ok: false, reason: `NX-API is for Cisco NX-OS, not ${d.platform}` } as const);
  }

  async push(device: DeviceRef, commands: string[]): Promise<PushOutcome> {
    const bad = blockedLines(commands, "nxos");
    if (bad.length) return { ok: false, text: `Refused before sending anything: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}.`, applied: [], failedAt: bad[0].line };
    try {
      // NX-API separates configuration commands with " ;". Lines containing ";" were already blocked.
      const outs = await this.call(device, "cli_conf", commands.join(" ;"));
      const failed = outs.findIndex((o) => !ok(o));
      if (failed < 0) return { ok: true, text: redactSecrets(outs.map((o) => (typeof o.body === "string" ? o.body : "")).join("\n").trim()), applied: commands, failedAt: null };
      const at = outs[failed].input && commands.includes(outs[failed].input!.trim()) ? outs[failed].input!.trim() : (commands[failed] ?? null);
      return { ok: false, text: redactSecrets(`${outs[failed].msg ?? "The switch refused a line."}`), applied: commands.slice(0, Math.max(0, failed)), failedAt: at };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e), applied: [], failedAt: null };
    }
  }

  async save(device: DeviceRef): Promise<CommandOutcome> {
    try {
      const [o] = await this.call(device, "cli_show_ascii", "copy running-config startup-config");
      return { ok: ok(o), text: redactSecrets(typeof o.body === "string" ? o.body : String(o.msg ?? "")) };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }
}
