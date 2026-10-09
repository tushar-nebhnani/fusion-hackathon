import { Router } from "express";
import type { UpstreamStatus } from "../services/climate/open-meteo.js";

export interface HealthDeps {
  checkDb: () => Promise<void>;
  upstreamStatus: () => UpstreamStatus;
}

// Service and upstream status. Upstream state is the outcome of the most
// recent real call, so a health check never spends Open-Meteo quota.
export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const dbUp = await deps.checkDb().then(
      () => true,
      () => false,
    );
    const upstream = deps.upstreamStatus();
    const status = !dbUp ? "down" : upstream.state === "down" ? "degraded" : "ok";

    res.status(dbUp ? 200 : 503).json({
      status,
      db: dbUp ? "up" : "down",
      upstream: { open_meteo: upstream },
    });
  });

  return router;
}
