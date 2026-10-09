import type { CookieOptions, RequestHandler } from "express";
import { z } from "zod";
import { BadRequestError } from "../errors/app-error.js";
import { auditNote } from "../middleware/audit.js";
import { requireUser, sessionToken } from "../middleware/auth.js";
import { AUTH } from "../services/auth/config.js";
import type { AuthService } from "../services/auth/service.js";

export interface AuthCookieOptions {
  sameSite: "lax" | "none";
  secure: boolean;
}

// A Google ID token is about 1,200 characters
const signInBody = z.strictObject({ credential: z.string().min(1).max(4096) });

export function authController(auth: AuthService, cookie: AuthCookieOptions) {
  // httpOnly keeps the token away from scripts on the page
  const cookieOptions: CookieOptions = { httpOnly: true, path: "/", ...cookie };

  // What a frontend needs to draw the Sign in with Google button
  const config: RequestHandler = (_req, res) => {
    res.json({ google_client_id: auth.googleClientId });
  };

  const google: RequestHandler = async (req, res) => {
    const body = signInBody.safeParse(req.body);
    if (!body.success) {
      throw new BadRequestError("Body must be { credential }: the ID token from Sign in with Google");
    }
    const { user, token, expiresAt } = await auth.signIn(body.data.credential);
    auditNote(res, { actor: user, target: { type: "user", id: user.id } });
    res.cookie(AUTH.cookieName, token, { ...cookieOptions, expires: expiresAt });
    res.json({ user });
  };

  const me: RequestHandler = (_req, res) => {
    res.json({ user: requireUser(res) });
  };

  const logout: RequestHandler = async (req, res) => {
    const token = sessionToken(req);
    if (token) await auth.signOut(token);
    res.clearCookie(AUTH.cookieName, cookieOptions);
    res.status(204).end();
  };

  return { config, google, me, logout };
}
