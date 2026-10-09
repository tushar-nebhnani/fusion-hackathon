import "dotenv/config";
import { z } from "zod";

// Alert settings are read apart from config/env.ts on purpose: that file
// stops the process on an invalid value, and a bad alert setting must never
// stop the API. Here an invalid value falls back to its default.

export interface AlertsConfig {
  enabled: boolean;
  mode: "dry_run" | "live";
  pollSeconds: number;
  cooldownHours: number;
  timezone: string;
  // Local time the bank's daily WATCH digest goes out, in minutes after midnight
  digestTime: number;
  dashboardUrl: string;
  smtp: { host: string; port: number; user?: string; password?: string; from?: string };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value: string): number | undefined {
  const match = TIME.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

const clock = (fallback: number) =>
  z
    .string()
    .transform((value, ctx) => minutes(value) ?? (ctx.addIssue("Expected HH:MM"), z.NEVER))
    .catch(fallback);

const timezone = z
  .string()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  })
  .catch("Asia/Kolkata");

// A blank line in .env ("KEY=") means "not set"
const optional = z
  .preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional())
  .catch(undefined);

const schema = z.object({
  ALERTS_ENABLED: z.enum(["true", "false"]).catch("true"),
  ALERTS_MODE: z.enum(["dry_run", "live"]).catch("dry_run"),
  ALERTS_POLL_SECONDS: z.coerce.number().int().min(1).max(3600).catch(15),
  ALERTS_COOLDOWN_HOURS: z.coerce.number().min(0).max(720).catch(6),
  ALERTS_TZ: timezone,
  ALERTS_DIGEST_TIME: clock(9 * 60),
  ALERTS_DASHBOARD_URL: z.url().catch("http://localhost:3000"),
  SMTP_HOST: z.string().min(1).catch("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().catch(587),
  SMTP_USER: optional,
  SMTP_APP_PASSWORD: optional,
  ALERTS_FROM_EMAIL: optional,
});

export function loadAlertsConfig(
  source: Record<string, string | undefined> = process.env,
): AlertsConfig {
  const env = schema.parse(source);
  return {
    enabled: env.ALERTS_ENABLED === "true",
    mode: env.ALERTS_MODE,
    pollSeconds: env.ALERTS_POLL_SECONDS,
    cooldownHours: env.ALERTS_COOLDOWN_HOURS,
    timezone: env.ALERTS_TZ,
    digestTime: env.ALERTS_DIGEST_TIME,
    dashboardUrl: env.ALERTS_DASHBOARD_URL.replace(/\/+$/, ""),
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_APP_PASSWORD,
      from: env.ALERTS_FROM_EMAIL,
    },
  };
}
