export type Severity = "critical" | "warning" | "info";

/**
 * confirmed: the device output itself shows the problem.
 * suspected: the output is consistent with a problem but does not prove it; `verification` says how to find out.
 */
export type FindingStatus = "confirmed" | "suspected";

export type Finding = {
  /** Stable across runs, so a problem that persists keeps its identity. */
  id: string;
  kind: string;
  severity: Severity;
  status: FindingStatus;
  device: string;
  deviceId: string;
  interface: string | null;
  peer: { device: string; deviceId: string; interface: string } | null;
  linkId: string | null;
  title: string;
  description: string;
  /** Lines taken from device output, each prefixed with the device and command they came from. */
  evidence: string[];
  probableCause: string;
  recommendedAction: string;
  /** How the finding was established, or the command that would settle it. */
  verification: string;
};

export type IfaceObservation = { status: "up" | "down" | "administratively down" | "deleted" | string; protocol: "up" | "down" | string; ip: string | null };

/** `command` is what was really sent when it differs from the logical key the result is stored under. */
export type CommandResult = { ok: boolean; text: string; command?: string };

export type DeviceSnapshot = {
  nodeId: string;
  label: string;
  kind: string;
  commands: Record<string, CommandResult>;
};

export type PingResult = { fromId: string; from: string; to: string; toIp: string; linkId: string; successRate: number | null; sent: number | null; output: string; error?: string };

export type DeviceReport = { nodeId: string; label: string; kind: string; inspected: boolean; reason: string | null; commandsRun: number; commandsFailed: number };

export type RunSummary = {
  id: string;
  labId: string;
  startedAt: string;
  finishedAt: string;
  devices: DeviceReport[];
  /** Per node id, per normalised interface name: what the device reported. Drives link colours on the topology. */
  interfaces: Record<string, Record<string, IfaceObservation>>;
  pings: { linkId: string; ok: boolean; successRate: number | null }[];
  notRun: string[];
};
