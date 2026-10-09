import { Router } from "express";
import { authController, type AuthCookieOptions } from "../controllers/auth.controller.js";
import type { AuthService } from "../services/auth/service.js";

export function authRouter(auth: AuthService, cookie: AuthCookieOptions): Router {
  const controller = authController(auth, cookie);
  const router = Router();

  router.get("/config", controller.config);
  router.post("/google", controller.google);
  router.get("/me", controller.me);
  router.post("/logout", controller.logout);

  return router;
}
