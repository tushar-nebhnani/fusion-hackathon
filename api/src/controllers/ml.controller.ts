import type { RequestHandler } from "express";
import type { z } from "zod";
import { BadRequestError } from "../errors/app-error.js";
import { anomalySchema, calibrateAlertSchema, climateCashflowSchema, type MlClient } from "../services/ml/index.js";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new BadRequestError(
    "Invalid request",
    result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  );
}

// Nothing here is stored: each answer is computed from the request alone.
export function mlController(client: MlClient) {
  const status: RequestHandler = async (_req, res) => {
    res.json(await client.status());
  };

  const calibrateAlert: RequestHandler = async (req, res) => {
    res.json(await client.calibrateAlert(parse(calibrateAlertSchema, req.body)));
  };

  const anomaly: RequestHandler = async (req, res) => {
    res.json(await client.anomaly(parse(anomalySchema, req.body)));
  };

  const climateCashflow: RequestHandler = async (req, res) => {
    res.json(await client.climateCashflow(parse(climateCashflowSchema, req.body)));
  };

  return { status, calibrateAlert, anomaly, climateCashflow };
}
