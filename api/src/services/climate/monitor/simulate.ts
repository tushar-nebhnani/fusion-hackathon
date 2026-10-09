import "dotenv/config";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { createClimateService } from "../profile.service.js";
import { fakeOpenMeteo } from "../testing/fake-open-meteo.js";
import { FakeClock } from "./adapters/clock.js";
import { createConsoleAlertSink } from "./adapters/consoleAlertSink.js";
import { createJsonLocationSource } from "./adapters/jsonLocationSource.js";
import { groupByCell } from "./cells.js";
import { loadMonitorConfig } from "./config.js";
import type { RunLogger } from "./ports.js";
import { createMonitorRepo } from "./repo.js";
import { createMonitor } from "./tick.js";

// Demo simulator:
//   npm run monitor:simulate -- --location L1 --scenario heavy-rain
//
// It runs real monitor ticks through the real climate pipeline, with two
// things replaced. Time is a FakeClock, so hours pass in milliseconds. And
// Open-Meteo is the climate unit's own test double, whose forecast each step
// scripts. Everything is written to a separate "<name>_sim" database, so a
// scripted flood never shows up in the real cache or on the demo page, and
// alerts are printed, never queued.

interface Step {
  title: string;
  // Daily values from today onwards; days not given are calm
  rain?: number[];
  tmax?: number[];
}

const CALM: Step = { title: "Calm forecast" };

const SCENARIOS: Record<string, Step[]> = {
  "heavy-rain": [
    CALM,
    { title: "The forecast turns: 130 mm of rain in two days", rain: [0, 20, 130, 90] },
    { title: "The rain has left the forecast" },
    { title: "Still calm" },
  ],
  heatwave: [
    CALM,
    { title: "The forecast turns: 46 °C in two days", tmax: [39, 43, 46, 46, 44] },
    { title: "The heat has left the forecast" },
    { title: "Still calm" },
  ],
  calm: [CALM, { title: "Still calm" }, { title: "Still calm" }],
};

const { values } = parseArgs({
  options: {
    location: { type: "string", default: "L1" },
    scenario: { type: "string", default: "heavy-rain" },
  },
});

const say = (line = "") => console.log(line);
const time = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

// Only problems are shown; the steps below report what happened
const logger: RunLogger = {
  info: () => undefined,
  warn: (message) => console.warn(`  ! ${message}`),
  error: (message) => console.error(`  ! ${message}`),
};

async function main(): Promise<void> {
  const steps = SCENARIOS[values.scenario];
  if (!steps) {
    console.error(`Unknown scenario "${values.scenario}". Use one of: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const config = { ...loadMonitorConfig(), enabled: true, agentEnabled: false };
  const all = await createJsonLocationSource(resolve(config.locationsFile), logger).list();
  const chosen = all.find((location) => location.locationId === values.location);
  if (!chosen) {
    console.error(
      `No location "${values.location}" in ${config.locationsFile}. ` +
        `Use one of: ${all.map((location) => location.locationId).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  // Every business in the chosen location's cell is watched, as in a real tick
  const cellId = groupByCell([chosen])[0]?.cellId;
  const watched = groupByCell(all).find((group) => group.cellId === cellId)?.locations ?? [chosen];

  // The simulation's own database, created and migrated on first use
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost:5432/fusion");
  if (!url.pathname.endsWith("_sim")) url.pathname += "_sim";
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

  try {
    await prisma.$executeRaw`
      TRUNCATE TABLE disaster_events, monitored_cells, request_log, cell_events, hazard_scores,
        climate_metrics, climate_responses, cell_hazard_relevance, point_static_features, points,
        grid_cells
      RESTART IDENTITY CASCADE`;

    const clock = new FakeClock(new Date());
    const openMeteo = fakeOpenMeteo(() => clock.now());
    const quiet = { error: () => undefined, warn: () => undefined };
    const climate = createClimateService({ prisma, openMeteo, now: () => clock.now(), logger: quiet });
    const repo = createMonitorRepo(prisma);
    const sink = createConsoleAlertSink((line) => say(`  ${line}`));
    const monitor = createMonitor({
      config,
      climate,
      source: { list: () => Promise.resolve(watched) },
      sink,
      logger,
      clock,
      repo,
      instanceId: "simulator",
    });

    say(`Scenario "${values.scenario}" at ${chosen.label ?? chosen.locationId}, cell ${String(cellId)}`);
    say(`Businesses in the cell: ${watched.map((l) => l.businessId).join(", ")}`);
    say(`Synthetic weather, simulated time, database ${url.pathname.slice(1)}. Nothing is sent.`);

    let level = "NORMAL";
    for (const [index, step] of steps.entries()) {
      openMeteo.climateOf.forecastRain = step.rain ?? [];
      openMeteo.climateOf.forecastTmax = step.tmax ?? [];
      say();
      say(`[${index + 1}/${steps.length}] ${time(clock.now())}  ${step.title}`);

      const summary = await monitor.tick();
      const cell = cellId ? await repo.getCell(cellId) : null;
      if (!cell || summary.checked !== 1) {
        say("  The check did not complete; see the message above.");
        process.exitCode = 1;
        return;
      }
      const hours = (cell.nextCheckAt.getTime() - clock.now().getTime()) / 3_600_000;
      say(
        `  Level ${level} -> ${cell.level}` +
          (summary.suddenChanges > 0
            ? `, sudden change, alerts printed above: ${summary.alerts}`
            : `, calm runs in a row: ${cell.calmRuns}`) +
          `. Next check in ${hours} h.`,
      );
      level = cell.level;
      // Jump straight to the moment the cell is due again
      clock.set(cell.nextCheckAt);
    }

    say();
    say("Disaster events recorded for the ML model:");
    const events = await repo.listEvents(cellId);
    if (events.length === 0) say("  none");
    for (const event of events) {
      say(
        `  #${event.eventId} ${event.hazard} ${event.level} ${event.windowStart} to ${event.windowEnd}, ` +
          `${event.status}: ${event.evidence}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
