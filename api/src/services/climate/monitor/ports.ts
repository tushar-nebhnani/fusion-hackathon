import type { Hazard } from "../types.js";

// The three things the monitor does not own. Each has a small stand-in in
// adapters/; README.md says how to swap in the real unit.

export interface WatchedLocation {
  locationId: string;
  businessId: string;
  lat: number;
  lon: number;
  label?: string;
}

// Locations with an active loan. Stand-in: a JSON file. Later: the loans DB.
export interface WatchedLocationSource {
  list(): Promise<WatchedLocation[]>;
}

// Structurally the alert system's event (services/alerts/types.ts), so its
// `enqueue` is an AlertSink as it stands
export interface AlertEvent {
  businessId: string;
  hazard: Hazard;
  severity: "WATCH" | "WARNING" | "CRITICAL";
  // ISO dates
  windowStart: string;
  windowEnd: string;
  evidence: string;
  sourceRunId: string;
}

// Resolves to whether the event was accepted. Must not be relied on to
// throw: a sink that fails is logged and monitoring carries on.
export interface AlertSink {
  enqueue(event: AlertEvent): Promise<boolean>;
}

// Stand-in: the console. Later: the logs system.
export interface RunLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface Clock {
  now(): Date;
}
