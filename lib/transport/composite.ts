import type { CommandOutcome, DeviceRef, DeviceTransport, PushOptions, PushOutcome } from "../core/types";

/**
 * Routes each device to the transport its inventory entry names (ssh, netconf, eapi, nxapi), so one network can mix
 * them. Every call goes straight to that device's own transport; no safety check lives here, because each transport
 * enforces its own.
 */
export class CompositeTransport implements DeviceTransport {
  readonly kind = "mixed" as const;
  constructor(private pick: (d: DeviceRef) => DeviceTransport | null, private all: () => (DeviceTransport & { closeAll?: () => void })[]) {}

  private of(d: DeviceRef): DeviceTransport | null {
    return this.pick(d);
  }

  async run(d: DeviceRef, command: string): Promise<CommandOutcome> {
    return this.of(d)?.run(d, command) ?? { ok: false, text: `${d.label}: no way to reach this device is configured.` };
  }

  pushSupport(d: DeviceRef) {
    const t = this.of(d);
    if (!t) return { ok: false, reason: "no way to reach this device is configured" } as const;
    return t.pushSupport?.(d) ?? ({ ok: true } as const);
  }

  async push(d: DeviceRef, commands: string[], opts?: PushOptions): Promise<PushOutcome> {
    return this.of(d)?.push(d, commands, opts) ?? { ok: false, text: `${d.label}: no way to reach this device is configured.`, applied: [], failedAt: null };
  }

  /** Present for every device; a device whose transport has no provisional commits is simply already final. */
  async confirm(d: DeviceRef): Promise<CommandOutcome> {
    const t = this.of(d);
    return t?.confirm ? t.confirm(d) : { ok: true, text: "Nothing to confirm." };
  }

  async save(d: DeviceRef): Promise<CommandOutcome> {
    return this.of(d)?.save(d) ?? { ok: false, text: `${d.label}: no way to reach this device is configured.` };
  }

  closeAll(): void {
    for (const t of this.all()) t.closeAll?.();
  }
}
