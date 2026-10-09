import { Router } from "express";
import { advisorController } from "../controllers/advisor.controller.js";
import type { Advisor } from "../services/advisor/index.js";

export function advisorRouter(advisor: Advisor, options: { devRoutes: boolean }): Router {
  const controller = advisorController(advisor);
  const router = Router();

  router.get("/businesses", controller.businesses);
  router.post("/chat", controller.chat);
  router.post("/damage-report", controller.damageReport);
  router.post("/proposals/:id/decision", controller.decide);
  router.get("/conversations/:businessId", controller.conversations);
  router.get("/loans/:loanId/state", controller.loanState);
  router.post("/loans/:loanId/disburse", controller.disburse);
  router.post("/loans/:loanId/close-recovery", controller.closeRecovery);

  // Never mounted in production (see loadAdvisorConfig)
  if (options.devRoutes) {
    router.post("/dev/fake-alert", controller.fakeAlert);
    router.post("/dev/verify-alert", controller.verifyAlert);
    router.post("/dev/sweep-alerts", controller.sweepAlerts);
  }

  return router;
}
