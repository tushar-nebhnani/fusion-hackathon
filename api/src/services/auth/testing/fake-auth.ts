import type { Express } from "express";
import request from "supertest";
import { AUTH } from "../config.js";
import { invalidCredential, type GoogleIdentity, type GoogleVerifier } from "../google.js";
import type { AuthService, AuthUser } from "../service.js";

export const OWNER: AuthUser = {
  id: "user-owner",
  email: "owner@example.com",
  name: "Asha Owner",
  picture_url: null,
  role: "owner",
};

export const OTHER_OWNER: AuthUser = { ...OWNER, id: "user-other", email: "other@example.com" };

export const BANK: AuthUser = {
  id: "officer-7",
  email: "officer@bank.example",
  name: "Ravi Officer",
  picture_url: null,
  role: "bank",
};

// Cookie header of a session that `fakeAuth` knows
export const cookieFor = (user: AuthUser) => `${AUTH.cookieName}=${user.id}`;

// A supertest client that sends `user`'s session cookie with every request
export function signedIn(app: Express, user: AuthUser = OWNER) {
  return request.agent(app).set("Cookie", cookieFor(user));
}

// Row for the `users` table; a business can only be owned by a stored user
export const userRow = (user: AuthUser) => ({
  id: user.id,
  googleSub: `sub-${user.id}`,
  email: user.email,
  name: user.name,
});

// Stand-in for the auth service: the session token is the user's id, and
// nothing is stored. For route tests that are not about signing in.
export function fakeAuth(users: readonly AuthUser[] = [OWNER, OTHER_OWNER, BANK]): AuthService {
  const byToken = new Map(users.map((user) => [user.id, user]));
  return {
    googleClientId: "test-client-id",
    signIn: () => Promise.reject(new Error("fakeAuth cannot sign in; use createAuthService")),
    authenticate: (token) => Promise.resolve(byToken.get(token) ?? null),
    signOut: () => Promise.resolve(),
    purgeExpired: () => Promise.resolve(0),
  };
}

// Stand-in for Google: a credential is valid when it is a key of `identities`
export function fakeGoogle(identities: Record<string, GoogleIdentity>): GoogleVerifier {
  return {
    verify(credential) {
      const identity = identities[credential];
      return identity ? Promise.resolve(identity) : Promise.reject(invalidCredential());
    },
  };
}
