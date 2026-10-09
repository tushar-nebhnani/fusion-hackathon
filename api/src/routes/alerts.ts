import { Router } from "express";
import { alertsController } from "../controllers/alerts.controller.js";
import type { AlertReader } from "../services/alerts/reader.js";

export function alertsRouter(reader: AlertReader): Router {
  const controller = alertsController(reader);
  const router = Router();

  router.get("/", controller.list);

  return router;
}
