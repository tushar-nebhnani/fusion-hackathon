import { CLIMATE } from "../config/climate.js";
import type { ClimateRefresher } from "../services/climate/profile.service.js";

const HOUR_MS = 3_600_000;

export interface RefreshJobOptions {
  intervalMs?: number;
  logger?: Pick<Console, "info" | "error">;
}

// Refreshes stored climate data every 6 hours. The first run is one interval
// after start, not at boot, so restarting the server (or `tsx watch`
// reloading it) never triggers a burst of upstream calls.
// In-process: with several API instances, each one would run it.
export function startClimateRefresh(
  refresher: ClimateRefresher,
  options: RefreshJobOptions = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? CLIMATE.refreshHours * HOUR_MS;
  const logger = options.logger ?? console;
  let running = false;

  async function tick(): Promise<void> {
    if (running) {
      logger.info("climate refresh: previous run still in progress, skipping this one");
      return;
    }
    running = true;
    try {
      const summary = await refresher.refreshAll();
      logger.info(
        `climate refresh: ${summary.points - summary.failed} of ${summary.points} locations updated`,
      );
    } catch (error) {
      logger.error("climate refresh: run failed", error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  // The HTTP server keeps the process alive; this timer should not
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
