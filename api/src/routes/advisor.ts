import { Router } from "express";
import { advisorController, type AdvisorAccess, type EnqueueAlert } from "../controllers/advisor.controller.js";
import { requireBank } from "../middleware/auth.js";
import type { Advisor } from "../services/advisor/index.js";

export function advisorRouter(
  advisor: Advisor,
  options: { devRoutes: boolean; assertAccess: AdvisorAccess; enqueue?: EnqueueAlert },
): Router {
  const controller = advisorController(advisor, options.assertAccess, options.enqueue);
  const router = Router();

  router.get("/businesses", controller.businesses);
  router.post("/chat", controller.chat);
  router.post("/damage-report", controller.damageReport);
  // Bank decisions: README §1 rule 3, the agent proposes and the bank decides
  router.post("/proposals/:id/decision", requireBank, controller.decide);
  router.get("/conversations/:businessId", controller.conversations);
  router.get("/loans/:loanId/state", controller.loanState);
  router.post("/loans/:loanId/disburse", requireBank, controller.disburse);
  router.post("/loans/:loanId/close-recovery", requireBank, controller.closeRecovery);

  // Never mounted in production (see loadAdvisorConfig)
  if (options.devRoutes) {
    router.post("/dev/fake-alert", controller.fakeAlert);
    router.post("/dev/verify-alert", controller.verifyAlert);
    router.post("/dev/sweep-alerts", controller.sweepAlerts);
  }

  return router;
}
