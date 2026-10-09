import { pathToFileURL } from "node:url";
import { createLoop } from "./loop.js";

// The background monitor (npm run monitor). A process of its own: it shares
// the climate unit's code, database and cache with the API, and nothing else.
// It is never started from the API server.

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main(): Promise<void> {
  const { buildMonitor } = await import("./container.js");
  const built = buildMonitor();
  const { config, logger, monitor, agentVersion } = built;
  const loop = createLoop({
    tick: () => monitor.tick(),
    tickMs: config.tickMinutes * 60_000,
    logger,
  });

  // Log and keep going. The API is a different process and is unaffected.
  process.on("unhandledRejection", (reason) => logger.error(`unhandled rejection: ${describe(reason)}`));
  process.on("uncaughtException", (error) => logger.error(`uncaught exception: ${describe(error)}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("stopping after the cells being checked");
      monitor.stop();
      loop.stop();
    });
  }

  logger.info(
    `${monitor.instanceId}: tick every ${config.tickMinutes} min, up to ${config.concurrency} cells at once, ` +
      `locations from ${config.locationSource === "json" ? config.locationsFile : "live loans"}, alerts to ${config.alertSink}, ` +
      `agent ${agentVersion ?? "off"}` +
      (config.enabled ? "" : " (MONITOR_ENABLED=false, idling)"),
  );
  await loop.run();
  try {
    await monitor.release();
  } catch (error) {
    logger.error(`leases could not be released: ${describe(error)}`);
  }
  await built.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
