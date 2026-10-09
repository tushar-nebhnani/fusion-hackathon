import type { Request, RequestHandler } from "express";
import { requireUser } from "../middleware/auth.js";
import type { EvaluatorService } from "../services/evaluator/service.js";

function businessId(req: Request): string {
  const value = req.params.id;
  return typeof value === "string" ? value : "";
}

export function evaluatorController(service: EvaluatorService) {
  const evaluate: RequestHandler = async (req, res) => {
    res.json(await service.evaluate({ businessId: businessId(req), requesterId: requireUser(res).id }));
  };

  const history: RequestHandler = async (req, res) => {
    res.json({ evaluations: await service.history(businessId(req)) });
  };

  return { evaluate, history };
}
