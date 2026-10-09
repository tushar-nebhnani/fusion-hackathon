import { Router } from "express";
import { climateController } from "../controllers/climate.controller.js";
import type { ClimateService } from "../services/climate/profile.service.js";

export function climateRouter(service: ClimateService): Router {
  const controller = climateController(service);
  const router = Router();

  router.post("/profile", controller.profile);
  router.get("/events", controller.events);
  router.get("/cell/:cellId", controller.cell);

  return router;
}
