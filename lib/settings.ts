import { z } from "zod";

export const EXECUTION_MODES = ["suggest", "approve", "autopilot"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** User-editable preferences, stored in SQLite. Nothing secret lives here. */
export const settingsSchema = z.object({
  executionMode: z.enum(EXECUTION_MODES).default("approve"),
  /** Autopilot may only run configuration changes when this is on. Read-only operations never need approval. */
  autopilotAllowConfig: z.boolean().default(false),
  snapshotBeforeChange: z.boolean().default(true),
  diagnosticsOnLabSelect: z.boolean().default(false),
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
    selectedLabId: z.string().nullable().optional(),
    selectedLabTitle: z.string().nullable().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});
