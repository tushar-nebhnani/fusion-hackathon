import { Router, type RequestHandler } from "express";
import { financeController } from "../controllers/finance.controller.js";
import { requireUser } from "../middleware/auth.js";
import type { FinanceService } from "../services/finance/index.js";
import type { InputService } from "../services/input/service.js";

export interface FinanceRouterDeps {
  service: FinanceService;
  // The input service's ownership check: an owner reaches only the
  // businesses they created, a bank officer reaches all of them
  assertAccess: InputService["assertAccess"];
}

export function financeRouter(deps: FinanceRouterDeps): Router {
  const controller = financeController(deps.service);
  const router = Router();

  // One check for every route under a business
  const ownBusiness: RequestHandler = async (req, res, next) => {
    const user = requireUser(res);
    const id = req.params.id;
    await deps.assertAccess(typeof id === "string" ? id : "", { role: user.role, id: user.id });
    next();
  };
  router.use("/business/:id", ownBusiness);

  router.get("/demo", controller.demo);
  router.post("/evaluate-location", controller.evaluateLocation);
  router.get("/business/:id/profile", controller.profile);
  router.get("/business/:id/profiles", controller.history);
  router.post("/business/:id/scenario", controller.scenario);
  router.post("/business/:id/repayment-capacity", controller.repaymentCapacity);

  return router;
}
