import { Router } from "express";
import { mlController } from "../controllers/ml.controller.js";
import type { MlClient } from "../services/ml/index.js";

export function mlRouter(client: MlClient): Router {
  const controller = mlController(client);
  const router = Router();

  router.get("/status", controller.status);
  router.post("/alerts/calibrate", controller.calibrateAlert);
  router.post("/anomaly", controller.anomaly);
  router.post("/climate-cashflow", controller.climateCashflow);

  return router;
}
