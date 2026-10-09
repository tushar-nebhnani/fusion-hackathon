import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "./errors/app-error.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { climateRouter } from "./routes/climate.js";
import { healthRouter, type HealthDeps } from "./routes/health.js";
import type { ClimateService } from "./services/climate/profile.service.js";

export interface AppDeps extends HealthDeps {
  climate: ClimateService;
  // Requests per minute per client on /climate; each one can cost upstream calls
  climateRateLimit?: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  app.use("/health", healthRouter(deps));
  app.use(
    "/climate",
    rateLimit({
      windowMs: 60_000,
      limit: deps.climateRateLimit ?? 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(new AppError("Too many requests, slow down", 429, "RATE_LIMITED"));
      },
    }),
    climateRouter(deps.climate),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
