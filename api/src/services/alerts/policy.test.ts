import { describe, expect, it } from "vitest";
import { loadAlertsConfig } from "./config.js";
import {
  backoffMs,
  firstTryAt,
  inCooldown,
  localMinutes,
  nextLocalTime,
} from "./policy.js";

const config = loadAlertsConfig({});
// IST is UTC+05:30
const at = (istTime: string) => new Date(`2026-10-09T${istTime}:00+05:30`);

describe("alert policy", () => {
  it("reads the local clock in the configured timezone", () => {
    expect(localMinutes(new Date("2026-10-09T17:30:00Z"), "Asia/Kolkata")).toBe(23 * 60);
    expect(localMinutes(new Date("2026-10-09T18:30:00Z"), "Asia/Kolkata")).toBe(0);
  });

  it("finds the next occurrence of a local time, never the current minute", () => {
    expect(nextLocalTime(at("23:10"), 7 * 60, "Asia/Kolkata")).toEqual(
      new Date("2026-10-10T07:00:00+05:30"),
    );
    expect(nextLocalTime(at("06:59"), 7 * 60, "Asia/Kolkata")).toEqual(at("07:00"));
    expect(nextLocalTime(at("07:00"), 7 * 60, "Asia/Kolkata")).toEqual(
      new Date("2026-10-10T07:00:00+05:30"),
    );
  });

  it("lets only a higher severity through the cooldown", () => {
    expect(inCooldown("WATCH", [])).toBe(false);
    expect(inCooldown("WATCH", ["WATCH"])).toBe(true);
    expect(inCooldown("WARNING", ["WATCH"])).toBe(false);
    expect(inCooldown("WARNING", ["WATCH", "CRITICAL"])).toBe(true);
    expect(inCooldown("WATCH", ["WARNING"])).toBe(true);
  });

  it("backs off 1, 2, 4, 8, 16 minutes", () => {
    expect([1, 2, 3, 4, 5].map((attempts) => backoffMs(attempts) / 60_000)).toEqual([1, 2, 4, 8, 16]);
  });

  it("holds the bank's WATCH alerts for the daily digest and sends the rest now", () => {
    const now = at("11:30");
    expect(firstTryAt({ audience: "bank", severity: "WATCH" }, now, config)).toEqual(
      new Date("2026-10-10T09:00:00+05:30"),
    );
    expect(firstTryAt({ audience: "bank", severity: "WARNING" }, now, config)).toBe(now);
    expect(firstTryAt({ audience: "owner", severity: "WATCH" }, now, config)).toBe(now);
  });
});

describe("alert config", () => {
  it("uses the documented defaults", () => {
    expect(config).toMatchObject({
      enabled: true,
      mode: "dry_run",
      pollSeconds: 15,
      cooldownHours: 6,
      timezone: "Asia/Kolkata",
      digestTime: 9 * 60,
    });
  });

  it("falls back to a default instead of throwing on an invalid value", () => {
    const broken = loadAlertsConfig({
      ALERTS_ENABLED: "yes",
      ALERTS_MODE: "loud",
      ALERTS_POLL_SECONDS: "soon",
      ALERTS_TZ: "Mars/Olympus",
      SMTP_PORT: "-1",
      SMTP_APP_PASSWORD: "",
    });
    expect(broken).toMatchObject({
      enabled: true,
      mode: "dry_run",
      pollSeconds: 15,
      timezone: "Asia/Kolkata",
    });
    expect(broken.smtp.port).toBe(587);
    expect(broken.smtp.password).toBeUndefined();
  });
});
