import type { Request, RequestHandler } from "express";
import { requireUser } from "../middleware/auth.js";
import type { FinanceService } from "../services/finance/index.js";

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

function businessId(req: Request): string {
  const value = req.params.id;
  return typeof value === "string" ? value : "";
}

export function financeController(service: FinanceService) {
  const profile: RequestHandler = async (req, res) => {
    res.json(await service.getFinanceProfile(businessId(req), { requesterId: requireUser(res).id }));
  };

  const history: RequestHandler = async (req, res) => {
    res.json({ profiles: await service.listProfiles(businessId(req)) });
  };

  const scenario: RequestHandler = async (req, res) => {
    res.json(await service.simulateScenario(businessId(req), req.body));
  };

  const repaymentCapacity: RequestHandler = async (req, res) => {
    res.json(await service.repaymentCapacity(businessId(req), req.body));
  };

  const evaluateLocation: RequestHandler = async (req, res) => {
    const body: unknown = req.body;
    res.json(
      await service.evaluateLocation(field(body, "business"), field(body, "lat"), field(body, "lon"), {
        requesterId: requireUser(res).id,
      }),
    );
  };

  const demo: RequestHandler = async (_req, res) => {
    res.json(await service.demo({ requesterId: requireUser(res).id }));
  };

  return { profile, history, scenario, repaymentCapacity, evaluateLocation, demo };
}
