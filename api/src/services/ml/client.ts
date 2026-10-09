import type { z } from "zod";
import { AppError, BadRequestError } from "../../errors/app-error.js";
import { ML } from "./config.js";
import {
  alertCalibrationSchema,
  anomalyResultSchema,
  climateCashflowResultSchema,
  mlHealthSchema,
  type AlertCalibration,
  type AnomalyBody,
  type AnomalyResult,
  type CalibrateAlertBody,
  type ClimateCashflowBody,
  type ClimateCashflowResult,
} from "./schemas.js";

// The only place the API talks to the Python service in `ml/`. That service
// has no sign-in of its own, so it must stay reachable from the API only.

export interface MlStatus {
  available: boolean;
  // Which model files the Python service has loaded
  models: Record<string, boolean>;
  hazard_params: boolean;
  reason: string | null;
}

export interface MlClient {
  status(): Promise<MlStatus>;
  calibrateAlert(body: CalibrateAlertBody): Promise<AlertCalibration>;
  anomaly(body: AnomalyBody): Promise<AnomalyResult>;
  climateCashflow(body: ClimateCashflowBody): Promise<ClimateCashflowResult>;
}

export interface MlClientOptions {
  url: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const unavailable = (reason: string) => new AppError(`The ML service is not available: ${reason}`, 503, "ML_UNAVAILABLE");

export function createMlClient(options: MlClientOptions): MlClient {
  const send = options.fetch ?? fetch;
  const base = options.url?.replace(/\/+$/, "") ?? null;

  async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    if (!base) throw unavailable("ML_SERVICE_URL is not set");
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? ML.timeoutMs),
      });
    } catch (error) {
      throw unavailable(error instanceof Error ? error.message : "no answer");
    }
    const reply: unknown = await response.json().catch(() => null);
    // Our schema is stricter than the Python one, so this is rare: a rule only it knows
    if (response.status === 422) throw new BadRequestError("The ML service refused the request", reply);
    if (!response.ok) throw new AppError(`The ML service answered ${String(response.status)}`, 502, "ML_FAILED");
    const parsed = schema.safeParse(reply);
    if (!parsed.success) throw new AppError("The ML service sent an answer we do not understand", 502, "ML_FAILED");
    return parsed.data;
  }

  return {
    async status() {
      try {
        const health = await call("/health", mlHealthSchema);
        return { available: true, models: health.models, hazard_params: health.hazard_params ?? false, reason: null };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        return { available: false, models: {}, hazard_params: false, reason };
      }
    },
    calibrateAlert: (body) => call("/alerts/calibrate", alertCalibrationSchema, body),
    anomaly: (body) => call("/anomaly", anomalyResultSchema, body),
    climateCashflow: (body) => call("/risk/climate-cashflow", climateCashflowResultSchema, body),
  };
}
