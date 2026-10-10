import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../errors/app-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AUTH } from "./config.js";
import type { GoogleVerifier } from "./google.js";

export type Role = "owner" | "bank";

// The signed-in user, as the API returns it
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: Role;
}

export interface SignedIn {
  user: AuthUser;
  // Goes into the session cookie and nowhere else
  token: string;
  expiresAt: Date;
}

export interface AuthService {
  // Null when sign-in is not configured
  readonly googleClientId: string | null;
  signIn(credential: string): Promise<SignedIn>;
  // Null for an unknown, signed-out or expired session
  authenticate(token: string): Promise<AuthUser | null>;
  signOut(token: string): Promise<void>;
  purgeExpired(): Promise<number>;
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  googleClientId?: string | null;
  // Without one, sign-in answers 503 and nobody can get a session
  verifier?: GoogleVerifier;
  bankEmails?: readonly string[];
  bankDomains?: readonly string[];
  // False makes every signed-in user a bank officer. On unless switched off.
  rolesEnforced?: boolean;
  now?: () => Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  hostedDomain: string | null;
}

// Only the hash is stored, so a copy of the table cannot be used to sign in
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const bankEmails = new Set(deps.bankEmails ?? []);
  const bankDomains = new Set(deps.bankDomains ?? []);
  const rolesEnforced = deps.rolesEnforced ?? true;

  // Worked out on every request, so a change to the allowlist applies to
  // sessions that already exist
  // A listed email is enough. A listed domain also needs Google to say the
  // account is managed by that domain (`hd`): anyone who once had a work
  // address can keep a consumer Google account made with it.
  function roleOf(email: string, hostedDomain: string | null): Role {
    if (!rolesEnforced) return "bank";
    const address = email.toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (bankEmails.has(address)) return "bank";
    return bankDomains.has(domain) && hostedDomain === domain ? "bank" : "owner";
  }

  const view = (row: UserRow): AuthUser => ({
    id: row.id,
    email: row.email,
    name: row.name,
    picture_url: row.pictureUrl,
    role: roleOf(row.email, row.hostedDomain),
  });

  return {
    googleClientId: deps.googleClientId ?? null,

    async signIn(credential) {
      if (!deps.verifier) {
        throw new AppError(
          "Sign in with Google is not configured (GOOGLE_CLIENT_ID is not set)",
          503,
          "AUTH_NOT_CONFIGURED",
        );
      }
      const identity = await deps.verifier.verify(credential);
      // The bank allowlist goes by email, so an unverified one proves nothing
      if (!identity.emailVerified) {
        throw new AppError("This Google account's email is not verified", 403, "EMAIL_NOT_VERIFIED");
      }

      const at = now();
      const profile = {
        email: identity.email,
        name: identity.name,
        pictureUrl: identity.picture,
        hostedDomain: identity.hostedDomain ?? null,
      };
      const user = await prisma.user.upsert({
        where: { googleSub: identity.sub },
        create: { googleSub: identity.sub, ...profile, lastLoginAt: at },
        update: { ...profile, lastLoginAt: at },
      });

      const token = randomBytes(AUTH.tokenBytes).toString("base64url");
      const expiresAt = new Date(at.getTime() + AUTH.sessionTtlMs);
      const role = roleOf(user.email, user.hostedDomain);
      await prisma.$transaction([
        // Sessions issued for another role end now rather than on their next use
        prisma.session.deleteMany({
          where: { userId: user.id, OR: [{ role: null }, { role: { not: role } }] },
        }),
        prisma.session.create({
          data: { tokenHash: hashToken(token), userId: user.id, createdAt: at, expiresAt, role },
        }),
      ]);
      return { user: view(user), token, expiresAt };
    },

    async authenticate(token) {
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { user: true },
      });
      if (!session || session.expiresAt <= now()) return null;
      // The role changed since sign-in (the allowlists or the email did): every
      // session of the user ends, and they sign in again with the new one
      if (session.role !== roleOf(session.user.email, session.user.hostedDomain)) {
        await prisma.session.deleteMany({ where: { userId: session.userId } });
        return null;
      }
      return view(session.user);
    },

    async signOut(token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    },

    async purgeExpired() {
      const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lte: now() } } });
      return count;
    },
  };
}
