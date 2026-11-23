import { z } from "zod";
import { maintenanceWindowSchema } from "./changes/window";

export const EXECUTION_MODES = ["suggest", "approve", "autopilot"] as const;
export const COMPLIANCE_MODES = ["off", "production", "all"] as const;
export type ComplianceMode = (typeof COMPLIANCE_MODES)[number];
/** Whether addresses, names and free text are replaced with stand-ins before anything is sent to Claude. */
export const PRIVACY_MODES = ["off", "production", "all"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** User-editable preferences, stored in SQLite. Nothing secret lives here. */
export const settingsSchema = z.object({
  executionMode: z.enum(EXECUTION_MODES).default("approve"),
  /** Autopilot may only run configuration changes when this is on. Read-only operations never need approval. */
  autopilotAllowConfig: z.boolean().default(false),
  snapshotBeforeChange: z.boolean().default(true),
  diagnosticsOnLabSelect: z.boolean().default(false),
  /** Security and hygiene baseline in Diagnostics (SSH v2, telnet, default SNMP, NTP...). Right for production, noise on throwaway labs. */
  complianceChecks: z.enum(COMPLIANCE_MODES).default("production"),
  /** Pseudonymise what is sent to Claude: production networks only by default, since a lab holds nothing worth hiding. */
  llmPrivacy: z.enum(PRIVACY_MODES).default("production"),
  /** Words that are always replaced when masking is on: customer, site or project names no configuration declares. */
  llmPrivateTerms: z.array(z.string().trim().min(2).max(64)).max(100).default([]),
  /** Extra words that describe what an object is for (VOICE, BRANCH) and are kept when masking names. Everything not known is hidden. */
  llmSafeWords: z.array(z.string().trim().min(1).max(32)).max(200).default([]),
  /** On a production network the person who proposed a change cannot be the one who approves it (when someone else can). */
  requireSecondApprover: z.boolean().default(true),
  /** On a production network a device must pass its readiness checks and be signed off before a change may touch it. */
  requireDeviceReadiness: z.boolean().default(true),
  /** When a change may be applied to a production network. Labs are never held to it. */
  maintenanceWindow: maintenanceWindowSchema.default(maintenanceWindowSchema.parse({})),
  /** Networks that are backed up and checked on a schedule. Empty means nothing runs by itself. */
  monitoredScopes: z.array(z.string().max(120)).max(50).default([]),
  /** Minutes between scheduled configuration backups of a monitored network. 0 is off. */
  backupIntervalMinutes: z.number().int().min(0).max(10080).default(0),
  /** Minutes between scheduled read-only diagnostics of a monitored network. 0 is off. */
  diagnosticsIntervalMinutes: z.number().int().min(0).max(10080).default(0),
  selectedLabId: z.string().nullable().default(null),
  selectedLabTitle: z.string().nullable().default(null),
});

export type Settings = z.infer<typeof settingsSchema>;
/**
 * A patch must not carry defaults: zod's .partial() on a schema with .default() fills the missing fields
 * back in, so saving one setting would silently reset all the others. Optional fields, no defaults.
 */
export const settingsPatchSchema = z
  .object({
    executionMode: z.enum(EXECUTION_MODES).optional(),
    autopilotAllowConfig: z.boolean().optional(),
    snapshotBeforeChange: z.boolean().optional(),
    diagnosticsOnLabSelect: z.boolean().optional(),
    complianceChecks: z.enum(COMPLIANCE_MODES).optional(),
    llmPrivacy: z.enum(PRIVACY_MODES).optional(),
    llmPrivateTerms: z.array(z.string().trim().min(2).max(64)).max(100).optional(),
    llmSafeWords: z.array(z.string().trim().min(1).max(32)).max(200).optional(),
    requireSecondApprover: z.boolean().optional(),
    requireDeviceReadiness: z.boolean().optional(),
    maintenanceWindow: maintenanceWindowSchema.optional(),
    monitoredScopes: z.array(z.string().max(120)).max(50).optional(),
    backupIntervalMinutes: z.number().int().min(0).max(10080).optional(),
    diagnosticsIntervalMinutes: z.number().int().min(0).max(10080).optional(),
    selectedLabId: z.string().nullable().optional(),
    selectedLabTitle: z.string().nullable().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});
