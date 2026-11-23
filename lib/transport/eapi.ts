import { checkReadOnlyCommand } from "../assistant/policy";
import { blockedLines } from "../core/safety";
import { resolveSecret, type Env } from "../core/secrets";
import type { CommandOutcome, DeviceRef, DeviceTransport, PushOutcome } from "../core/types";
import { redactSecrets } from "../security/redact";
import { ApiError, type ApiTarget, postJson } from "./http";

/**
 * Arista eAPI: JSON-RPC over HTTPS to /command-api. The commands are ordinary EOS CLI, so the same read-only allowlist
 * and the same blocked-line rules apply as over SSH. Written from Arista's documented eAPI; tested against a faithful
 * in-process server, not a real switch.
 */
type RpcResult = { result?: Record<string, unknown>[]; error?: { code?: number; message?: string; data?: { errors?: string[]; output?: string }[] } };

export class EapiTransport implements DeviceTransport {
  readonly kind = "eapi" as const;
  constructor(private targetFor: (d: DeviceRef) => ApiTarget | null, private env: Env = process.env) {}

  private async rpc(d: DeviceRef, cmds: string[]): Promise<RpcResult> {
    const t = this.targetFor(d);
    if (!t) throw new ApiError(`${d.label}: no eAPI address or credential is known for this device.`, "config");
    let password: string;
    try { password = resolveSecret(t.password, this.env); } catch (e) { throw new ApiError(e instanceof Error ? e.message : "A credential could not be read.", "config"); }
    return (await postJson(t, "/command-api", { jsonrpc: "2.0", method: "runCmds", params: { version: 1, cmds, format: "text" }, id: "tiny-snitch" }, { password })) as RpcResult;
  }

  async run(device: DeviceRef, command: string): Promise<CommandOutcome> {
    const check = checkReadOnlyCommand(command);
    if (!check.ok) return { ok: false, text: check.reason };
    try {
      const r = await this.rpc(device, [command.trim()]);
      if (r.error) return { ok: false, text: redactSecrets(describeError(r.error)) };
      return { ok: true, text: redactSecrets(String(r.result?.[0]?.output ?? "").replace(/\s+$/, "")) };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  pushSupport(d: DeviceRef) {
    return d.platform === "eos" ? ({ ok: true } as const) : ({ ok: false, reason: `eAPI is for Arista EOS, not ${d.platform}` } as const);
  }

  async push(device: DeviceRef, commands: string[]): Promise<PushOutcome> {
    const bad = blockedLines(commands, "eos");
    if (bad.length) return { ok: false, text: `Refused before sending anything: "${bad[0].line.slice(0, 60)}" ${bad[0].reason}.`, applied: [], failedAt: bad[0].line };
    try {
      // eAPI runs the list in order and stops at the first error. "enable" and "configure" come first and are not the caller's lines.
      const r = await this.rpc(device, ["enable", "configure", ...commands]);
      if (!r.error) return { ok: true, text: redactSecrets((r.result ?? []).map((x) => String(x.output ?? "")).join("\n").trim()), applied: commands, failedAt: null };
      const data = r.error.data ?? [];
      const at = data.findIndex((x) => x.errors?.length);
      const idx = at - 2; // skip enable + configure
      const failedAt = idx >= 0 ? commands[idx] ?? null : null;
      // Nothing after the failing line was run. Leave config mode so a half-entered session cannot linger.
      await this.rpc(device, ["end"]).catch(() => undefined);
      return { ok: false, text: redactSecrets(describeError(r.error)), applied: idx > 0 ? commands.slice(0, idx) : [], failedAt };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e), applied: [], failedAt: null };
    }
  }

  async save(device: DeviceRef): Promise<CommandOutcome> {
    try {
      const r = await this.rpc(device, ["enable", "write memory"]);
      return r.error ? { ok: false, text: redactSecrets(describeError(r.error)) } : { ok: true, text: String(r.result?.[1]?.output ?? "").trim() };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }
}

function describeError(e: NonNullable<RpcResult["error"]>): string {
  const detail = (e.data ?? []).flatMap((x) => x.errors ?? []).join(" ");
  return `${e.message ?? "The switch reported an error."}${detail ? ` ${detail}` : ""}`.trim();
}
