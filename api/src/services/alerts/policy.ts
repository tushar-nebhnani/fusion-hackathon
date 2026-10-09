import type { AlertsConfig } from "./config.js";
import type { Audience, Severity } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

export const MAX_ATTEMPTS = 5;

const RANK: Record<Severity, number> = { WATCH: 0, WARNING: 1, CRITICAL: 2 };

// Minutes after local midnight in `timeZone`
export function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

// The next moment, strictly after `now`, that the local clock reads `target`
export function nextLocalTime(now: Date, target: number, timeZone: string): Date {
  const wait = (target - localMinutes(now, timeZone) + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
  const startOfMinute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(startOfMinute + wait * MINUTE_MS);
}

// Inside the cooldown, only a severity higher than everything already sent
// gets through
export function inCooldown(severity: Severity, recentlySent: readonly Severity[]): boolean {
  return recentlySent.some((sent) => RANK[sent] >= RANK[severity]);
}

// 1, 2, 4, 8, 16 minutes after the 1st, 2nd, ... failed attempt
export function backoffMs(attempts: number): number {
  return 2 ** Math.max(0, attempts - 1) * MINUTE_MS;
}

// WATCH alerts for the bank wait for the daily digest
export function isDigest(alert: { audience: Audience; severity: Severity }): boolean {
  return alert.audience === "bank" && alert.severity === "WATCH";
}

export function firstTryAt(
  alert: { audience: Audience; severity: Severity },
  now: Date,
  config: AlertsConfig,
): Date {
  return isDigest(alert) ? nextLocalTime(now, config.digestTime, config.timezone) : now;
}
