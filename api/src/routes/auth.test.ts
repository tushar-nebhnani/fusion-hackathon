import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { disconnectDb, prisma } from "../config/db.js";
import type { AuthCookieOptions } from "../controllers/auth.controller.js";
import { memoryAuditRecorder } from "../services/audit/testing/memory-recorder.js";
import { AUTH, loadAuthEnv } from "../services/auth/config.js";
import type { GoogleIdentity } from "../services/auth/google.js";
import { createAuthService } from "../services/auth/service.js";
import { fakeGoogle } from "../services/auth/testing/fake-auth.js";

// Integration tests: the real Express app, auth service and Postgres. Only
// Google is a stand-in.
const START = new Date("2026-10-09T06:00:00Z");
let clock = START;

const ASHA: GoogleIdentity = {
  sub: "g-1",
  email: "asha@example.com",
  emailVerified: true,
  name: "Asha",
  picture: "https://example.com/asha.png",
};
const IDENTITIES: Record<string, GoogleIdentity> = {
  "asha-token": ASHA,
  "officer-token": { ...ASHA, sub: "g-2", email: "Ravi@Bank.Example", name: "Ravi", hostedDomain: "bank.example" },
  // A consumer Google account made with a work address: no hosted domain
  "former-token": { ...ASHA, sub: "g-5", email: "old@bank.example", name: "Former", hostedDomain: null },
  "listed-token": { ...ASHA, sub: "g-3", email: "meera@example.org", name: "Meera" },
  "unverified-token": { ...ASHA, sub: "g-4", email: "ceo@bank.example", emailVerified: false },
};

interface SetupOptions {
  configured?: boolean;
  cookie?: AuthCookieOptions;
  rateLimit?: number;
  rolesEnforced?: boolean;
}

function setup(options: SetupOptions = {}) {
  const configured = options.configured ?? true;
  const service = createAuthService({
    prisma,
    googleClientId: configured ? "client-id" : null,
    verifier: configured ? fakeGoogle(IDENTITIES) : undefined,
    bankEmails: ["meera@example.org"],
    bankDomains: ["bank.example"],
    rolesEnforced: options.rolesEnforced,
    now: () => clock,
  });
  const audit = memoryAuditRecorder();
  const app = createApp({
    auth: { service, cookie: options.cookie, rateLimit: options.rateLimit },
    audit,
    climate: {
      getProfile: () => Promise.resolve({ grade: "C" } as never),
      getCell: () => Promise.reject(new Error("not used")),
    },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
  });
  const signIn = (credential: string) => request(app).post("/auth/google").send({ credential });
  return { app, service, signIn, audit };
}

const setCookie = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
// "name=value" of the session cookie, ready for a Cookie header
const sessionOf = (res: request.Response) => setCookie(res)[0]?.split(";")[0] ?? "";
const codeOf = (res: request.Response) => (res.body as { error: { code: string } }).error.code;

beforeEach(async () => {
  clock = START;
  await prisma.$executeRaw`TRUNCATE TABLE users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("POST /auth/google", () => {
  it("signs a Google account in and sets an httpOnly session cookie", async () => {
    const { app, signIn } = setup();

    const res = await signIn("asha-token");
    const me = await request(app).get("/auth/me").set("Cookie", sessionOf(res));

    expect(res.status).toBe(200);
    const user = {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      email: "asha@example.com",
      name: "Asha",
      picture_url: "https://example.com/asha.png",
      role: "owner",
    };
    expect(res.body).toEqual({ user });
    expect(me.body).toEqual({ user });

    const cookie = setCookie(res)[0] ?? "";
    expect(cookie).toContain(`${AUTH.cookieName}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // AUTH.sessionTtlMs (8 hours) after the test clock
    expect(cookie).toContain("Expires=Fri, 09 Oct 2026 14:00:00 GMT");
    expect(cookie).not.toContain("Secure");
    // The token goes out in the cookie only
    expect(JSON.stringify(res.body)).not.toContain(sessionOf(res).split("=")[1]);
  });

  it("stores only a hash of the session token", async () => {
    const { signIn } = setup();

    const token = sessionOf(await signIn("asha-token")).split("=")[1] ?? "";

    const sessions = await prisma.session.findMany();
    expect(token).toHaveLength(43);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions[0]?.tokenHash).not.toContain(token);
  });

  it("keeps one user per Google account and refreshes the profile", async () => {
    const { signIn } = setup();
    const first = await signIn("asha-token");
    IDENTITIES["asha-token"] = { ...ASHA, name: "Asha K", email: "asha.k@example.com" };

    const second = await signIn("asha-token");
    IDENTITIES["asha-token"] = ASHA;

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(2);
    expect(second.body).toMatchObject({
      user: { id: (first.body as { user: { id: string } }).user.id, name: "Asha K", email: "asha.k@example.com" },
    });
  });

  it("makes allowlisted emails and domains bank officers", async () => {
    const { signIn } = setup();

    const byDomain = await signIn("officer-token");
    const byEmail = await signIn("listed-token");

    expect(byDomain.body).toMatchObject({ user: { role: "bank", email: "Ravi@Bank.Example" } });
    expect(byEmail.body).toMatchObject({ user: { role: "bank" } });
  });

  it("trusts a bank domain only for accounts that domain's Google Workspace manages", async () => {
    const { signIn } = setup();

    const res = await signIn("former-token");

    expect(res.body).toMatchObject({ user: { email: "old@bank.example", role: "owner" } });
  });

  it("makes everyone a bank officer while roles are switched off", async () => {
    const { app, signIn } = setup({ rolesEnforced: false });

    const res = await signIn("asha-token");
    const me = await request(app).get("/auth/me").set("Cookie", sessionOf(res));

    expect(res.body).toMatchObject({ user: { email: "asha@example.com", role: "bank" } });
    expect(me.body).toMatchObject({ user: { role: "bank" } });
    // Signing in is still required
    expect((await request(app).get("/auth/me")).status).toBe(401);
  });

  it("leaves an audit event for a sign-in, a failed one and a sign-out, without the credential", async () => {
    const { app, signIn, audit } = setup();

    await signIn("forged-token");
    const res = await signIn("asha-token");
    await request(app).post("/auth/logout").set("Cookie", sessionOf(res));

    const user = await prisma.user.findFirstOrThrow();
    expect(audit.events).toMatchObject([
      { action: "POST /auth/google", actorId: null, outcome: "denied", reason: "INVALID_CREDENTIAL" },
      { action: "POST /auth/google", actorId: user.id, actorRole: "owner", targetType: "user", outcome: "success" },
      { action: "POST /auth/logout", actorId: user.id, outcome: "success" },
    ]);
    const stored = JSON.stringify(audit.events);
    expect(stored).not.toContain("token");
    expect(stored).not.toContain(sessionOf(res).split("=")[1]);
  });

  it("refuses a credential Google did not issue for this app", async () => {
    const { signIn } = setup();

    const res = await signIn("forged-token");

    expect(res.status).toBe(401);
    expect(codeOf(res)).toBe("INVALID_CREDENTIAL");
    expect(setCookie(res)).toEqual([]);
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses an account whose email is not verified", async () => {
    const { signIn } = setup();

    const res = await signIn("unverified-token");

    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe("EMAIL_NOT_VERIFIED");
    expect(await prisma.session.count()).toBe(0);
  });

  it("answers 400 for a body that is not { credential }", async () => {
    const { app } = setup();

    for (const body of [{}, { credential: "" }, { credential: 7 }, { credential: "a", role: "bank" }]) {
      const res = await request(app).post("/auth/google").send(body);
      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe("BAD_REQUEST");
    }
  });

  it("answers 503 until a Google client id is configured", async () => {
    const { app, signIn } = setup({ configured: false });

    const res = await signIn("asha-token");

    expect(res.status).toBe(503);
    expect(codeOf(res)).toBe("AUTH_NOT_CONFIGURED");
    expect((await request(app).get("/auth/config")).body).toEqual({ google_client_id: null });
  });

  it("marks the cookie Secure and SameSite=None for a frontend on another site", async () => {
    const { signIn } = setup({ cookie: { sameSite: "none", secure: true } });

    const cookie = setCookie(await signIn("asha-token"))[0] ?? "";

    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });

  it("has its own, stricter rate limit", async () => {
    const { signIn } = setup({ rateLimit: 2 });

    await signIn("forged-token");
    await signIn("forged-token");
    const res = await signIn("asha-token");

    expect(res.status).toBe(429);
    expect(codeOf(res)).toBe("RATE_LIMITED");
  });
});

describe("sessions", () => {
  it("open the protected routes", async () => {
    const { app, signIn } = setup();
    const cookie = sessionOf(await signIn("asha-token"));
    const point = { lat: 26.1445, lon: 91.7362 };

    const anonymous = await request(app).post("/climate/profile").send(point);
    const signedIn = await request(app).post("/climate/profile").set("Cookie", cookie).send(point);

    expect(anonymous.status).toBe(401);
    expect(signedIn.status).toBe(200);
  });

  it("answer 401 on /auth/me without one", async () => {
    const { app } = setup();

    const none = await request(app).get("/auth/me");
    const unknown = await request(app).get("/auth/me").set("Cookie", `${AUTH.cookieName}=nope`);

    expect(none.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(codeOf(unknown)).toBe("UNAUTHORIZED");
  });

  it("end after eight hours", async () => {
    expect(AUTH.sessionTtlMs).toBe(8 * 3_600_000);
    const { app, signIn } = setup();
    const cookie = sessionOf(await signIn("asha-token"));
    const me = () => request(app).get("/auth/me").set("Cookie", cookie);

    clock = new Date(START.getTime() + AUTH.sessionTtlMs - 1000);
    const before = await me();
    clock = new Date(START.getTime() + AUTH.sessionTtlMs);
    const after = await me();

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
  });

  it("are revoked by POST /auth/logout", async () => {
    const { app, signIn } = setup();
    const cookie = sessionOf(await signIn("asha-token"));
    const other = sessionOf(await signIn("asha-token"));

    const res = await request(app).post("/auth/logout").set("Cookie", cookie);

    expect(res.status).toBe(204);
    expect(setCookie(res)[0]).toContain(`${AUTH.cookieName}=;`);
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).status).toBe(401);
    // Signing out one browser leaves the others signed in
    expect((await request(app).get("/auth/me").set("Cookie", other)).status).toBe(200);
    expect((await request(app).post("/auth/logout")).status).toBe(204);
  });

  it("are purged once they have expired", async () => {
    const { service, signIn } = setup();
    await signIn("asha-token");
    clock = new Date(START.getTime() + 1000);
    await signIn("asha-token");

    clock = new Date(START.getTime() + AUTH.sessionTtlMs);

    expect(await service.purgeExpired()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it("all end when the user's role changes, so a removed officer loses bank access at once", async () => {
    const first = setup();
    const cookie = sessionOf(await first.signIn("listed-token"));
    await first.signIn("listed-token");
    expect((await request(first.app).get("/auth/me").set("Cookie", cookie)).body).toMatchObject({
      user: { role: "bank" },
    });

    // The same database after meera@example.org is taken off the allowlist
    const service = createAuthService({ prisma, bankEmails: [], now: () => clock });
    const after = await service.authenticate(cookie.split("=")[1] ?? "");

    expect(after).toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });

  it("issued for another role end when the user signs in again", async () => {
    const { signIn } = setup();
    await signIn("asha-token");
    await prisma.session.updateMany({ data: { role: "bank" } });

    await signIn("asha-token");

    expect(await prisma.session.findMany({ select: { role: true } })).toEqual([{ role: "owner" }]);
  });
});

describe("loadAuthEnv", () => {
  it("reads the allowlists and origins as trimmed, lower-cased lists", () => {
    const env = loadAuthEnv({
      GOOGLE_CLIENT_ID: " abc.apps.googleusercontent.com ",
      AUTH_BANK_EMAILS: "Meera@Example.org, ,ravi@example.org",
      AUTH_BANK_DOMAINS: "@Bank.Example",
      AUTH_ALLOWED_ORIGINS: "http://localhost:3000/, https://app.example.com",
    });

    expect(env).toEqual({
      googleClientId: "abc.apps.googleusercontent.com",
      bankEmails: ["meera@example.org", "ravi@example.org"],
      bankDomains: ["bank.example"],
      rolesEnforced: true,
      allowedOrigins: ["http://localhost:3000", "https://app.example.com"],
      cookieSameSite: "lax",
      cookieSecure: false,
    });
  });

  it("falls back to safe defaults and never throws", () => {
    const blank = loadAuthEnv({ AUTH_COOKIE_SAMESITE: "strictest" });

    expect(blank).toEqual({
      googleClientId: null,
      bankEmails: [],
      bankDomains: [],
      rolesEnforced: true,
      allowedOrigins: ["http://localhost:3000"],
      cookieSameSite: "lax",
      cookieSecure: false,
    });
    expect(loadAuthEnv({ AUTH_ROLES_ENFORCED: "no" }).rolesEnforced).toBe(true);
    expect(loadAuthEnv({ AUTH_ROLES_ENFORCED: "false" }).rolesEnforced).toBe(false);
    // Roles cannot be switched off where real data is held
    expect(loadAuthEnv({ AUTH_ROLES_ENFORCED: "false", NODE_ENV: "production" }).rolesEnforced).toBe(true);
    expect(loadAuthEnv({ NODE_ENV: "production" }).cookieSecure).toBe(true);
    expect(loadAuthEnv({ AUTH_COOKIE_SAMESITE: "none" }).cookieSecure).toBe(true);
  });

  it("allows every origin with \"*\", except in production", () => {
    expect(loadAuthEnv({ AUTH_ALLOWED_ORIGINS: "*" }).allowedOrigins).toEqual(["*"]);
    expect(loadAuthEnv({ AUTH_ALLOWED_ORIGINS: "*, https://app.example.com", NODE_ENV: "production" }).allowedOrigins).toEqual([
      "https://app.example.com",
    ]);
  });
});
