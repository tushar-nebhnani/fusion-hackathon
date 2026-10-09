import { Router, type RequestHandler } from "express";
import { evaluatorController } from "../controllers/evaluator.controller.js";
import { requireUser } from "../middleware/auth.js";
import type { EvaluatorService } from "../services/evaluator/service.js";
import type { InputService } from "../services/input/service.js";

export interface EvaluatorRouterDeps {
  service: EvaluatorService;
  // The input service's ownership and sharing check, as on /finance
  assertAccess: InputService["assertAccess"];
}

export function evaluatorRouter(deps: EvaluatorRouterDeps): Router {
  const controller = evaluatorController(deps.service);
  const router = Router();

  const ownBusiness: RequestHandler = async (req, res, next) => {
    const user = requireUser(res);
    const id = req.params.id;
    await deps.assertAccess(typeof id === "string" ? id : "", { role: user.role, id: user.id });
    next();
  };
  router.use("/business/:id", ownBusiness);

  // Stores the evaluation it returns, like GET /finance/business/:id/profile
  router.get("/business/:id", controller.evaluate);
  router.get("/business/:id/history", controller.history);

  return router;
}
