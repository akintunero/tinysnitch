import { z } from "zod";

/**
 * A maintenance window: the days and hours in which a change may be applied to a production network. Outside it a
 * change can be scheduled for inside it, or (by someone who gives a reason that is audited) applied anyway.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const maintenanceWindowSchema = z.object({
  enabled: z.boolean().default(false),
  /** 0 = Sunday ... 6 = Saturday. The day a window *starts*: a Friday 22:00 to 06:00 window runs into Saturday morning. */
  days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  start: z.string().regex(HHMM, "use HH:MM, 24 hour").default("22:00"),
  end: z.string().regex(HHMM, "use HH:MM, 24 hour").default("06:00"),
  timezone: z.string().max(64).default("UTC").refine((tz) => {
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
  }, "not a known time zone, e.g. Europe/London"),
});

export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;
export const DEFAULT_WINDOW: MaintenanceWindow = maintenanceWindowSchema.parse({});

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function local(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: DAY.indexOf(get("weekday")), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether `at` falls inside the window. A disabled window never blocks anything. */
export function inWindow(w: MaintenanceWindow, at: Date = new Date()): boolean {
  if (!w.enabled) return true;
  const { day, minutes } = local(at, w.timezone);
  const s = toMinutes(w.start), e = toMinutes(w.end);
  if (s === e) return w.days.includes(day); // start and end equal: the whole of each listed day
  if (s < e) return w.days.includes(day) && minutes >= s && minutes < e;
  // Overnight: the part after midnight belongs to the window that started the day before.
  return (w.days.includes(day) && minutes >= s) || (w.days.includes((day + 6) % 7) && minutes < e);
}

export function describeWindow(w: MaintenanceWindow): string {
  const days = w.days.length === 7 ? "every day" : [...w.days].sort().map((d) => DAY[d]).join(", ") || "no days";
  return `${days}, ${w.start} to ${w.end} (${w.timezone})`;
}
