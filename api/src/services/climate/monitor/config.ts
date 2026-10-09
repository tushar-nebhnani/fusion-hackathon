import "dotenv/config";
import { z } from "zod";
import { CLIMATE } from "../../../config/climate.js";
import type { MonitorSettings } from "./types.js";

// MONITOR_* settings are read apart from config/env.ts, like the alert
// system's: an invalid value falls back to its default and never stops a
// process. Everything else comes from CLIMATE.monitor.

export interface MonitorConfig extends MonitorSettings {
  enabled: boolean;
  tickMinutes: number;
  concurrency: number;
  agentEnabled: boolean;
  // `input` watches the businesses with a live loan in the input service's
  // tables; `json` reads locationsFile instead
  locationSource: "input" | "json";
  locationsFile: string;
  // `outbox` hands alerts to the alert system; `console` only prints them
  alertSink: "outbox" | "console";
}

const flag = (fallback: "true" | "false") => z.enum(["true", "false"]).catch(fallback);

const schema = z.object({
  MONITOR_ENABLED: flag("true"),
  MONITOR_TICK_MINUTES: z.coerce.number().min(1).max(1440).catch(CLIMATE.monitor.tickMinutes),
  MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(50).catch(CLIMATE.monitor.concurrency),
  MONITOR_AGENT_ENABLED: flag("false"),
  MONITOR_LOCATION_SOURCE: z.enum(["input", "json"]).catch("input"),
  MONITOR_LOCATIONS_FILE: z.string().min(1).catch("data/monitor-locations.json"),
  MONITOR_ALERT_SINK: z.enum(["outbox", "console"]).catch("outbox"),
});

export function loadMonitorConfig(
  source: Record<string, string | undefined> = process.env,
): MonitorConfig {
  const env = schema.parse(source);
  const settings: MonitorSettings = CLIMATE.monitor;
  return {
    ...settings,
    enabled: env.MONITOR_ENABLED === "true",
    tickMinutes: env.MONITOR_TICK_MINUTES,
    concurrency: env.MONITOR_CONCURRENCY,
    agentEnabled: env.MONITOR_AGENT_ENABLED === "true",
    locationSource: env.MONITOR_LOCATION_SOURCE,
    locationsFile: env.MONITOR_LOCATIONS_FILE,
    alertSink: env.MONITOR_ALERT_SINK,
  };
}
