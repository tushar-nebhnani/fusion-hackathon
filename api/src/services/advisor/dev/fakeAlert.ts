import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdvisorAlertEvent } from "../types.js";

// Emits a monitor-shaped alert event (README §5 Mode 2) for demos, standing in
// for the background monitor until BACKGROUND_JOB.md is built.

const HOUR_MS = 3_600_000;

export const fakeAlertOptionsSchema = z.object({
  loanIds: z.array(z.string().min(1)).min(1).max(50).default(["LN-0142"]),
  hazard: z.string().min(1).max(40).default("heavy_rain"),
  severity: z.enum(["watch", "warning", "severe"]).default("warning"),
  // The window opens this many hours from now and lasts `durationHours`
  startsInHours: z.number().min(0).max(240).default(18),
  durationHours: z.number().min(0.01).max(240).default(24),
  cellId: z.string().min(1).max(100).default("demo-cell"),
});
export type FakeAlertOptions = z.input<typeof fakeAlertOptionsSchema>;

export function buildFakeAlert(options: FakeAlertOptions = {}, now = new Date()): AdvisorAlertEvent {
  const o = fakeAlertOptionsSchema.parse(options);
  const start = now.getTime() + o.startsInHours * HOUR_MS;
  return {
    alertId: `fake-${randomUUID().slice(0, 8)}`,
    cellId: o.cellId,
    hazard: o.hazard,
    severity: o.severity,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + o.durationHours * HOUR_MS).toISOString(),
    loanIds: o.loanIds,
  };
}
