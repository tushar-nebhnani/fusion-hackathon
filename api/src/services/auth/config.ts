import "dotenv/config";
import { z } from "zod";

const DAY_MS = 86_400_000;

export const AUTH = {
  cookieName: "fusion_session",
  // A session ends this long after sign-in; it is not extended by use
  sessionTtlMs: 7 * DAY_MS,
  // Requests per minute per client on /auth
  rateLimit: 20,
  // Bytes of randomness in a session token
  tokenBytes: 32,
} as const;

export interface AuthEnv {
  // Null until GOOGLE_CLIENT_ID is set; sign-in then answers 503
  googleClientId: string | null;
  // Lower-cased emails and domains whose users are bank officers
  bankEmails: string[];
  bankDomains: string[];
  // False while the owner/bank split is switched off: every signed-in user
  // is then a bank officer. Always true in production.
  rolesEnforced: boolean;
  // Browser origins, other than the API's own, that may call it with the cookie
  allowedOrigins: string[];
  // `none` is needed when the frontend is on a different site from the API
  cookieSameSite: "lax" | "none";
  cookieSecure: boolean;
}

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

// Read apart from config/env.ts, like the alert settings: an invalid value
// here falls back to its default and never stops the API.
const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().catch(""),
  AUTH_BANK_EMAILS: z.string().catch(""),
  AUTH_BANK_DOMAINS: z.string().catch(""),
  // Anything but an explicit "false" keeps the roles on, and production
  // keeps them on whatever this says
  AUTH_ROLES_ENFORCED: z.enum(["true", "false"]).catch("true"),
  AUTH_ALLOWED_ORIGINS: z.string().catch("http://localhost:3000"),
  AUTH_COOKIE_SAMESITE: z.enum(["lax", "none"]).catch("lax"),
  NODE_ENV: z.string().catch("development"),
});

export function loadAuthEnv(source: NodeJS.ProcessEnv = process.env): AuthEnv {
  const parsed = schema.parse(source);
  const cookieSameSite = parsed.AUTH_COOKIE_SAMESITE;
  return {
    googleClientId: parsed.GOOGLE_CLIENT_ID.trim() || null,
    bankEmails: list(parsed.AUTH_BANK_EMAILS),
    bankDomains: list(parsed.AUTH_BANK_DOMAINS).map((domain) => domain.replace(/^@/, "")),
    rolesEnforced: parsed.AUTH_ROLES_ENFORCED === "true" || parsed.NODE_ENV === "production",
    // Origins are compared as the browser sends them, without a trailing slash
    allowedOrigins: list(parsed.AUTH_ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, "")),
    cookieSameSite,
    // Browsers drop a SameSite=None cookie that is not Secure
    cookieSecure: parsed.NODE_ENV === "production" || cookieSameSite === "none",
  };
}
