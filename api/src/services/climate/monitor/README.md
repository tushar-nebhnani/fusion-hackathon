# Background monitor

The monitor watches every location that has an active loan. When the forecast for a location suddenly gets worse, it checks that place more often, hands an alert to the alert system for each business there, and records the forecast so it can later be compared with what really happened.

It is part of the climate unit, not a system of its own. It gets its data by calling the climate unit's normal pipeline and keeps its state in the same database. It runs as separate processes and is never started inside the API server.

## Run it

Run these inside `api/`. Postgres and Redis must be up and the migrations applied (`npm run db:migrate`).

| Command | What it does |
| --- | --- |
| `npm run monitor` | The tick loop. Runs until Ctrl+C, which lets the cells being checked finish and hands back their leases |
| `npm run monitor:verify` | The daily verification job. Runs once and exits, so schedule it with cron |
| `npm run monitor:simulate -- --location L1 --scenario heavy-rain` | A scripted demo in about 3 seconds. Scenarios: `heavy-rain`, `heatwave`, `calm` |

The simulator is safe to run at any time. It uses synthetic weather, simulated time and its own database (`<name>_sim`, created on first use), and it prints alerts instead of queueing them. Nothing it does reaches the real cache, the demo page or anyone's inbox.

`npm run monitor` is the real thing. It calls Open-Meteo, and by default it queues alerts in the alert system's outbox. Whether those are emailed depends on `ALERTS_MODE` and on whether `npm run alerts:worker` is running.

### Settings (`api/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `MONITOR_ENABLED` | `true` | `false` makes both processes idle. Nothing else changes |
| `MONITOR_TICK_MINUTES` | `15` | How often the loop looks for due cells |
| `MONITOR_CONCURRENCY` | `5` | Cells checked at once |
| `MONITOR_AGENT_ENABLED` | `false` | Optional agent review. Also needs `OPENAI_API_KEY` |
| `MONITOR_LOCATIONS_FILE` | `data/monitor-locations.json` | Watched locations, until the loans DB exists |
| `MONITOR_ALERT_SINK` | `outbox` | `console` prints alerts instead of queueing them |

An invalid value falls back to its default; it never stops a process. Every other number (check intervals, rain classes, timeouts) is in the `monitor` section of `src/config/climate.ts`.

## What one tick does

1. Reads the watched locations and groups them by the climate unit's 0.1° forecast cell. A monitor cell has the same id as the forecast cache's cell.
2. Brings `monitored_cells` in line. A new cell starts at `NORMAL` and is due at once. A cell with no location left is switched off.
3. For each cell whose `next_check_at` has passed, takes a lease on it and calls the climate unit once, with `forceFreshForecast: true`, however many businesses are in the cell.
4. Applies the rules to the fresh forecast and compares the result with the snapshot stored on the last check.
5. If any hazard rose, that is a sudden change: one alert per business in the cell, and one `disaster_events` row with status `pending`.
6. Saves the cell's level, calm count, snapshot and next check time, and hands the lease back.

A cell that fails keeps its state and is tried again on the next tick. One failing cell never stops the others.

### Levels and how often a cell is checked

| Level | Checked every |
| --- | --- |
| `NORMAL` | 6 hours |
| `WATCH` | 3 hours |
| `WARNING` | 1 hour |
| `SEVERE` | 1 hour |

A cell jumps straight to any higher level. It steps down one level at a time, and only after two calm checks in a row. A check is calm when no hazard rose and nothing is still at the cell's level; any other check resets the count.

The schedule is stored in the database, not in timers. That is why a restart loses nothing, and why two monitor instances can run side by side.

### The rules

The rules are in `rules.ts`. They are pure: no I/O and no clock reads.

| Hazard | `WATCH` | `WARNING` | `SEVERE` |
| --- | --- | --- | --- |
| `flash_flood` | A day with ≥ 64.5 mm of rain | ≥ 115.6 mm | ≥ 204.5 mm |
| `heat` | Max temperature ≥ 40 °C | ≥ 45 °C | |
| `storm` | Gusts ≥ 60 km/h | ≥ 90 km/h | |
| `river_flood` | The climate unit's own river event | Discharge above the cell's historical high | Above the high, with heavy rain forecast within 72 h |
| `cold_wave` | The climate unit's own cold event | The same, at warning | |

- Rain counts only when its probability is at least 25%. Where no probability is fetched, because the hazard is dormant, the amount alone decides.
- The historical high of a river is the 99th percentile the climate unit stored when it screened the cell.
- A dormant hazard whose tripwire trips is raised to at least `WARNING`, as section 3 of `services/alerts/job.md` asks.
- `drought` never raises anything. It is slow-onset, and the climate unit raises no events for it either.
- A hazard whose forecast is missing keeps its last level. A missing forecast is not evidence that the danger has passed.

### The agent (optional)

With `MONITOR_AGENT_ENABLED=true` the climate unit's agent scores the same forecast, at most once every 6 hours per cell and with a 20-second limit. A score of 0.6 or more can raise a hazard to `WATCH`, and 0.85 or more to `WARNING`. It cannot raise to `SEVERE`.

The final level of a hazard is always the higher of the rule level and the agent level. A lower answer from the agent is ignored and logged. If the agent fails or times out, the rule result is used.

### The verification job

Once the window of a `pending` event ended at least 5 days ago (the ERA5 archive runs that far behind), the job fetches what was observed in that cell.

- `hit`: the observed value crossed the same tripwire the forecast did.
- `false_alarm`: it did not.
- `missed`: over the last 7 observed days, an observed value crossed a tripwire and no event had forecast it.

Forecast and observed numbers are stored side by side in `forecast_values` and `observed_values`. This table is the training data for the ML model.

## What it reuses from the climate unit

| Need | Comes from |
| --- | --- |
| Fresh data for a location | `getProfileWithForecast()` in `profile.service.ts`: the normal cache, lock, fetch and score pipeline |
| Grid cells | `snapPoint()` in `grid.ts` |
| Validation of a location | `parseCoordinates()` in `coordinates.ts` |
| Hazard names, profile shape | `types.ts` and `schema.ts` |
| Heat, gust and cold thresholds | `LIMITS` in `hazards.ts` |
| Which hazards are dormant, the unit's own events, its forecast scores | The profile itself |
| The river's historical high | The stored screening indicators |
| The agent and its raise-only rule | `scoreForecast()` and `raises()` in `agent.ts` |
| Observed data | `archive()` and `floodHistory()` in `open-meteo.ts` |
| Storage | The same Prisma client and database |
| Error reporting | `AppError` codes and steps, logged as the unit reports them |
| Settings | `CLIMATE.monitor` in `src/config/climate.ts` |

Three additions were made to the climate unit for this. None changes anything for an existing caller, and tests in `src/routes/climate.test.ts` hold that in place.

- `getProfile(point, requesterId, { forceFreshForecast })` refetches the weather and river forecasts even while they are fresh. History, projections, elevation and screening stay cached.
- `getProfileWithForecast()` returns the same profile plus the daily forecast values the scores were computed from. The HTTP response is unchanged.
- `raises()` is the agent's raise-only check, taken out of `applyReview()` so the monitor uses the same one.

## The three ports

The monitor does not own the list of loans, the delivery of alerts or the log store. Each is an interface in `ports.ts`, and `container.ts` is the only file that picks an implementation.

| Port | Used today | To plug in the real unit |
| --- | --- | --- |
| `WatchedLocationSource` | `adapters/jsonLocationSource.ts`, reading `data/monitor-locations.json` | Write an adapter whose `list()` returns one `{ locationId, businessId, lat, lon }` per active loan, and pass it as `source` in `container.ts`. Run each row through `parseLocation()` so a bad coordinate is skipped, not fatal |
| `AlertSink` | The alert system's own `enqueue()`. Already plugged in | Nothing to do. `MONITOR_ALERT_SINK=console` switches to `adapters/consoleAlertSink.ts` for a dry look |
| `RunLogger` | `adapters/consoleRunLogger.ts` | Write an adapter with `info`, `warn` and `error`, and pass it as `logger` in `container.ts` |

Alerts are not de-duplicated here. The same event may be handed over twice, for example after a failed save, and the alert system drops the repeat by its dedupe key.

## Where this differs from the job description

- **The alert system already exists**, so the monitor queues real alerts by default. The console sink is kept for the simulator and for dry runs.
- **Tests sit next to the code** as `*.test.ts`, like everywhere else in `api/`, not in `__tests__/`.
- **The tick loop is in `loop.ts`** and `index.ts` only wires the process, so the loop can be tested without starting one.
- **`precipitation_probability_max` was already fetched** for cells where flash flood is not dormant. It was not added to the tripwire variables, which the root README says are exactly two.
- **A cell's first check gets 90 seconds, not 15**, because it may have to screen 30 years of history. First checks also run one at a time. Later checks get 15 seconds.
- **The verification job runs once and exits.** Scheduling it daily is left to cron.

## Things that will catch you out

- **The climate unit's per-cell lock is in-process.** A partial hit takes the same lock as a miss, but the monitor and the API are two processes, so they do not share it. The worst case is one duplicated forecast call for a cell; writes are upserts. Two monitor instances are kept apart by the leases in `monitored_cells`.
- **A cell is checked at one point**: the location with the lowest `locationId` in it. Weather is the same across a 0.1° cell, but the river forecast uses a 0.05° cell, so two businesses in one monitor cell can sit in different river cells.
- **The first run is slow on a cold cache.** Each new cell needs a 30-year history download, and Open-Meteo's free tier allows about one of those per minute. Cells that are rate limited fail fast and are retried on the next tick, so eight new cities take a few ticks to warm up. Asking the API for those locations beforehand avoids this.
- **A level raised only by the agent has no tripwire of its own.** Verification labels it against the hazard's lowest threshold.
- **`monitor:simulate` needs a role that can create a database** the first time. The Docker Compose user can.
