# Fusion Hackathon: Climate-Adjusted Financial Risk Score

A 24-hour hackathon project (Fusion 2026) that scores how exposed a small business in India is to climate hazards, so that the score can feed a financial risk assessment.

This README is the handover document for anyone, human or AI agent, picking up the repository cold. It describes what exists today, how it works, how to run it, and what is not built yet.

## Status at a glance

| Part | Folder | State |
| --- | --- | --- |
| Climate risk API | `api/` | Built and tested. 162 tests pass; typecheck and lint are clean. |
| Web frontend | `web/` | Untouched `create-next-app` scaffold. No project UI yet. |
| ML service | `ml/` | Dependencies declared only. No code, models, data or tests. |
| Postgres | `docker-compose.yml` | Used by the API. |
| Redis | `docker-compose.yml` | Running but unused. Reserved for a BullMQ job queue that does not exist yet. |

Everything of substance is in `api/`. Most of it is uncommitted: the two commits on `main` only contain the project skeleton.

## Repository layout

```
fusion-hackathon/
├── docker-compose.yml      Postgres 16 and Redis 7 for local development
├── .dockerignore           Written ahead of time; there are no Dockerfiles yet
├── .claude/settings.json   Enables the ECC plugin for Claude Code
├── api/                    Express + TypeScript + Prisma API (the real work)
├── web/                    Next.js 16 + React 19 + Tailwind 4 scaffold
└── ml/                     Python 3.13 project (FastAPI, scikit-learn), empty
```

## Quick start

Requirements: Node 24, Docker, and npm.

```bash
# 1. Start Postgres and Redis (from the repository root)
docker compose up -d

# 2. Configure and install the API
cd api
cp .env.example .env
npm install

# 3. Create the tables and generate the Prisma client
npm run db:migrate

# 4. Run the API on http://localhost:4000
npm run dev
```

Try it:

```bash
curl http://localhost:4000/health

curl -X POST http://localhost:4000/climate/profile \
  -H 'Content-Type: application/json' \
  -d '{"lat": 26.1445, "lon": 91.7362}'
```

Or open the demo page at http://localhost:4000/demo/. Opened straight from disk (`api/public/index.html`) it cannot reach the API and shows captured sample responses instead.

The first request for a new location downloads about 30 years of daily history from Open-Meteo and can take up to a minute. Later requests are served from Postgres.

### Environment variables (`api/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `4000` | |
| `DATABASE_URL` | none, required | `postgresql://fusion:fusion@localhost:5432/fusion?schema=public` matches Docker Compose |

They are validated at startup by `api/src/config/env.ts`; the process exits if one is invalid. No API key is needed: Open-Meteo's free tier is used without one.

### API commands (run inside `api/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the server with reload (`tsx watch`) |
| `npm run build` | Generates the Prisma client and compiles to `dist/` |
| `npm start` | Runs the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with type-checked rules |
| `npm test` | Runs all tests once |
| `npm run test:watch` | Runs tests in watch mode |
| `npm run db:generate` | Regenerates the Prisma client |
| `npm run db:migrate` | Creates and applies migrations in development |
| `npm run db:studio` | Opens Prisma Studio |

## What the API does

Given a latitude and longitude in India, the API returns a climate risk profile:

- an overall risk between 0 and 1, and a grade from A (lowest risk) to E;
- a score for each of six hazards: `river_flood`, `flash_flood`, `heat`, `drought`, `storm`, `cold_wave`;
- active events, raised when the 7-day forecast crosses a danger threshold;
- a confidence level and warnings that say which data sources were missing.

All weather data comes from [Open-Meteo](https://open-meteo.com). Postgres stores every response, so it is both the database and the cache.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/demo/` | MVP demo page (`api/public/index.html`) that calls the endpoints below |
| `GET` | `/health` | Service, database and upstream status |
| `POST` | `/climate/profile` | Full risk profile. Body: `{"lat": number, "lon": number}` |
| `GET` | `/climate/events?lat=..&lon=..` | Same pipeline, returning only location, active events, freshness, cache and warnings |
| `GET` | `/climate/cell/:cellId` | Debug view of what is stored for one grid cell, without raw payloads |

`/climate/*` is rate limited to 60 requests per minute per client. Request bodies are limited to 10 kB. There is no authentication.

`/health` returns 200 with `status: "ok"`, or `"degraded"` when the last Open-Meteo call failed, and 503 with `status: "down"` when Postgres is unreachable. It reports the outcome of the most recent real upstream call, so it never spends Open-Meteo quota.

### Profile response

The values below are illustrative. The exact shape is enforced by `climateProfileSchema` in `api/src/services/climate/schema.ts`, and every response is validated against it before it is sent.

```json
{
  "location": {
    "lat": 26.1445,
    "lon": 91.7362,
    "cells": {
      "historical": "0.1:26.1:91.7",
      "climate": "0.1:26.1:91.7",
      "flood": "0.05:26.15:91.75",
      "forecast": "0.1:26.1:91.7"
    }
  },
  "overall_climate_risk": 0.412,
  "grade": "C",
  "confidence": "med",
  "hazards": [
    {
      "hazard": "flash_flood",
      "relevance": "primary",
      "relevance_method": "static",
      "score": 0.598,
      "components": { "structural": 0.75, "historical": 0.667, "forecast": 0.2 },
      "reason": "Rain of 50 mm or more on 4.0 days per year"
    }
  ],
  "active_events": [
    {
      "hazard": "flash_flood",
      "severity": "watch",
      "window_start": "2026-10-10",
      "window_end": "2026-10-12",
      "confidence": 0.8
    }
  ],
  "data_freshness": {
    "forecast_issued_at": "2026-10-09T11:30:00+05:30",
    "history_until": "2026-10-03"
  },
  "cache": "miss",
  "warnings": ["flood_exposure_unavailable: World Bank exposure raster is not loaded"]
}
```

`hazards` always has all six hazards; the example shows one. `components.structural` only appears for the two flood hazards. `tripwire_promoted: true` appears on a hazard that is normally dormant but has an active event. `cache` is `miss` when a cell had to be screened, `partial_hit` when only some layers were refetched, and `complete_hit` when no upstream call was made.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "OUT_OF_RANGE", "message": "Latitude must be between -90 and 90", "step": "input_validation" } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_COORDINATES` | `lat` or `lon` is absent, null or empty |
| 400 | `INVALID_COORDINATES` | Not a number. Numeric strings are accepted only in query strings |
| 400 | `OUT_OF_RANGE` | Latitude outside ±90 or longitude outside ±180 |
| 422 | `OUTSIDE_COVERAGE` | Valid, but outside India's bounding box (latitude 6 to 37, longitude 68 to 98) |
| 400 | `INVALID_CELL_ID` | Cell id is not canonical, for example not `0.05:26.15:91.75` |
| 400 | `BAD_REQUEST` | Malformed JSON |
| 413 | `BAD_REQUEST` | Body over 10 kB |
| 404 | `NOT_FOUND` | Unknown route or method, or a valid cell with no data |
| 429 | `RATE_LIMITED` | More than 60 requests per minute |
| 503 | `UPSTREAM_UNAVAILABLE` | Weather history could not be fetched and nothing is cached |
| 500 | `INVALID_OUTPUT` | The generated profile failed its own schema check |
| 500 | `INTERNAL_ERROR` | Anything unexpected. The message is hidden in production |

Validation runs in a fixed order: presence, type, range, coverage. Coordinates are rounded to 4 decimal places, about 10 metres.

## How the climate pipeline works

The whole pipeline is `run()` in `api/src/services/climate/profile.service.ts`.

### 1. Snap the point to grid cells

Each data source has its own resolution. A point is snapped to the nearest cell centre for each one, and data is cached per cell, so nearby businesses share it.

| Layer | Resolution | Open-Meteo source |
| --- | --- | --- |
| historical | 0.1° | Archive API, ERA5-Seamless, from 1995 |
| climate | 0.1° | Climate API, models `EC_Earth3P_HR` and `MRI_AGCM3_2_S` |
| forecast | 0.1° | Forecast API, 7 days ahead and 5 back |
| flood | 0.05° | Flood API, river discharge history and a 30-day forecast |

A cell id is `<resolution>:<lat>:<lon>`, latitude first, for example `0.05:26.15:91.75`.

### 2. Screen each hazard (slow, cached for 90 days)

From about 30 years of history, one indicator is computed per hazard and compared with two thresholds. At or above the primary threshold the hazard is `primary`; below the dormant threshold it is `dormant`; otherwise it is `secondary`.

| Hazard | Indicator | Primary | Dormant |
| --- | --- | --- | --- |
| `flash_flood` | Days per year with rain ≥ 50 mm | 3 | 0.5 |
| `heat` | Days per year with max temperature > 40 °C | 20 | 2 |
| `drought` | Share of years with June to September rain below 75% of normal | 1/4 | 1/15 |
| `storm` | Days per year with gusts > 60 km/h | 5 | 0.5 |
| `cold_wave` | Days per year with min temperature < 4 °C | 5 | 0.5 |
| `river_flood` | 99th-percentile river discharge in m³/s | 1000 | 20 |

`river_flood` uses a World Bank flood exposure share instead (primary at 0.2, dormant below 0.02) when one is available. No exposure source is wired in yet, so discharge is always used.

Screening also fetches the elevation of the exact point and its eight neighbours about 1 km away, to work out whether the point sits lower than its surroundings.

### 3. Fetch the current forecast (fast, cached for hours)

The weather forecast and the river forecast are each cached for 6 hours and refetched once older than that. Dormant hazards cost almost nothing:

- only the two tripwire variables, `precipitation_sum` and `temperature_2m_max`, are always requested; other variables are added only for primary and secondary hazards;
- the river forecast is skipped entirely while `river_flood` is dormant.

### 4. Score

Each hazard has up to three components, each between 0 and 1:

- **structural**: built-in exposure of the exact point. Only the flood hazards have one. A point 10 m below its surroundings scores 1, and 10 m above scores 0.
- **historical**: the screening indicator. Reaching the primary threshold scores 0.5; twice the threshold scores 1.
- **forecast**: how close the next 7 days come to the hazard's danger level.

```
hazard score = 0.3 × structural + 0.5 × historical + 0.2 × forecast + projection adjustment
```

For hazards with no structural component, its weight moves to historical, giving 0.8 × historical. The projection adjustment adds up to 0.1 when climate models show heat, drought or heavy rain worsening between 1995–2014 and 2026–2045.

The overall risk is the average of the six hazard scores, weighted by relevance: primary 1, secondary 0.5, dormant 0.1. Grades: A below 0.2, B below 0.35, C below 0.5, D below 0.7, E otherwise.

### 5. Detect events

Events are separate from the score. One is raised when the forecast for the next 7 days crosses a threshold:

| Hazard | Watch | Warning |
| --- | --- | --- |
| `flash_flood` | 3-day rain above the cell's 95th percentile | Above its 99th percentile. Never below 30 mm |
| `heat` | ≥ 40 °C and above the cell's 95th percentile, or ≥ 45 °C | ≥ 40 °C and above the 99th percentile, or ≥ 45 °C |
| `storm` | Gusts ≥ 60 km/h | Gusts ≥ 90 km/h |
| `cold_wave` | Min temperature < 4 °C | Min temperature < 0 °C |
| `river_flood` | Discharge above the cell's 95th percentile | Above its 99th percentile |

Only `river_flood` can reach `severe`, when the ensemble median is also above the 99th percentile. Drought is slow-onset and raises no events. If a dormant hazard gets an event, it is reported as `secondary` with `tripwire_promoted: true` for that response.

Stored events are kept in step with the forecast: opened, updated, marked `escalated` when severity rises, and `closed` when the forecast clears.

### 6. Degrade instead of failing

| What failed | What happens |
| --- | --- |
| Weather history | 503 `UPSTREAM_UNAVAILABLE` |
| River history | `river_flood` is treated as secondary, confidence `low`, retried after 1 day |
| A forecast | That forecast signal is left out, confidence `low` |
| Climate projections, elevation or exposure | No adjustment or structural score, confidence `med` |
| A database write | Retried once, then logged. The response is still sent with a `persistence_failed` warning |

Stale data is never served: an expired screening profile or a forecast past its 6 hours is refetched or left out, not reused. Each case adds an entry to `warnings`. Upstream calls are retried up to 3 times with backoff for timeouts, 429 and 5xx; other 4xx responses are not retried.

## Code map (`api/`)

```
api/
├── prisma/schema.prisma          Database schema
├── prisma/migrations/            One migration: 20261009054117_climate_tool
├── prisma.config.ts              Prisma 7 config; the datasource URL lives here
├── vitest.config.ts              Points tests at a separate *_test database
├── vitest.global-setup.ts        Applies migrations to the test database
└── src/
    ├── server.ts                 Entry point: connects, wires dependencies, listens
    ├── app.ts                    createApp(deps): middleware, rate limit, routes
    ├── config/
    │   ├── env.ts                Validated environment variables
    │   ├── db.ts                 Prisma client, connectDb, disconnectDb
    │   └── climate.ts            Every tunable number in the pipeline
    ├── errors/app-error.ts       AppError and its 400/401/403/404/409 subclasses
    ├── middleware/error-handler.ts   404 handler and the single error formatter
    ├── routes/                   health.ts, climate.ts
    ├── controllers/climate.controller.ts   Parses input and calls the service
    ├── generated/prisma/         Generated client. Gitignored; never edit
    └── services/climate/
        ├── profile.service.ts    The pipeline: cache, fetch, score, save, respond
        ├── open-meteo.ts         HTTP client with retries, timeouts and validation
        ├── repository.ts         All database reads and writes
        ├── hazards.ts            Hazard catalog, thresholds and variable lists
        ├── screening.ts          Indicator to primary / secondary / dormant
        ├── scoring.ts            Component scores, overall risk, grade, events
        ├── stats.ts              Percentiles, rolling sums, indicators, projections
        ├── grid.ts               Cell snapping and cell id parsing
        ├── coordinates.ts        Input validation for lat and lon
        ├── schema.ts             Zod schema of the profile response
        ├── types.ts              Shared types
        └── testing/fake-open-meteo.ts   Synthetic Open-Meteo used by tests
```

Where to change things:

- **A threshold, weight, cache lifetime or grid size**: `src/config/climate.ts`, or `LIMITS` and `HAZARD_CATALOG` in `hazards.ts`.
- **The response shape**: `schema.ts`, then the object built at the end of `run()`. The schema is strict, so an extra key fails with `INVALID_OUTPUT`.
- **A new endpoint**: add a handler in a controller and register it in `routes/`. Throw an `AppError`; do not format error responses by hand.
- **A database column**: edit `schema.prisma`, then run `npm run db:migrate`.

## Database

Ten tables, defined in `api/prisma/schema.prisma`:

| Table | Holds |
| --- | --- |
| `hazard_catalog` | The six hazards and their rules. Seeded from code on the first request |
| `grid_cells` | One row per snapped cell |
| `points` | Each exact location requested, with its four cell ids |
| `point_static_features` | Elevation, relative elevation and flood exposure for a point |
| `cell_hazard_relevance` | Screening result per cell and hazard, with stored indicators and `review_after` |
| `climate_responses` | Raw Open-Meteo payloads. This table is the cache |
| `climate_metrics` | The same data normalised to one row per cell, date and variable |
| `hazard_scores` | Score history per point |
| `cell_events` | Events and their status: `open`, `escalated` or `closed` |
| `request_log` | Cache result and latency of each profile request |

A cached response is identified by cell, API name and a hash of the requested variables. Observed and projection metrics use the Unix epoch as `issued_at`, so refetching history never duplicates a day.

## Testing

```bash
cd api
npm test
```

- Tests run against a separate database. `vitest.config.ts` appends `_test` to the database name in `DATABASE_URL`, and the global setup applies migrations to it and refuses to run against a database whose name does not end in `_test`. Postgres must be running.
- Tests never call Open-Meteo. `fakeOpenMeteo` generates synthetic history and forecasts, records which APIs were called, and can simulate outages through its `failing` option.
- The route tests in `src/routes/climate.test.ts` are integration tests: the real Express app and real Postgres, with a controllable clock. They truncate all climate tables before each test.
- The full run takes about 30 seconds, because a cache miss stores roughly 30 years of daily metrics.

Before handing work over, run `npm run typecheck`, `npm run lint` and `npm test`. All three pass today.

## Conventions

- **ES modules with NodeNext resolution.** Relative imports must end in `.js`, even though the files are `.ts`.
- **Strict TypeScript** with `noUncheckedIndexedAccess`: indexing an array gives `T | undefined`.
- **Dependencies are passed in, not imported.** `createApp(deps)` and `createClimateService(deps)` take the database, the Open-Meteo client, the clock and the logger as arguments. Keep it that way; it is what makes the tests possible.
- **Express 5.** A rejected promise in an async handler reaches the error handler without a wrapper.
- **Latitude always comes first**, in function arguments, cell ids and upstream requests.
- **Unused arguments** are prefixed with `_`.
- **API responses use snake_case**; TypeScript code uses camelCase; database columns are snake_case through Prisma `@map`.
- **Dates and timestamps are in IST** (`Asia/Kolkata`).
- **Comments are short** and explain why, not what.

## Things that will catch you out

- **Comments mention "README section 12", "section 17" and "Call 7".** They refer to the original climate tool specification, which was never committed, not to this file. Read `src/config/climate.ts` and `schema.ts` instead.
- **Fetch the archive before the climate projections, never at the same time.** Open-Meteo counts both against one per-minute limit, and a 30-year request uses all of it. When projections fail, the profile is still returned and they are retried 5 minutes later. A test protects this order.
- **The per-cell lock is in-process.** It stops two simultaneous requests for a new cell from both downloading 30 years of history, but only inside one API instance.
- **Rate limiting is by IP address and `trust proxy` is not set.** Behind a reverse proxy, every client would share one limit.
- **Prisma 7.** The client is generated into `src/generated/prisma` and uses the `@prisma/adapter-pg` driver adapter. The database URL is in `prisma.config.ts`, not in `schema.prisma`.
- **`web/` uses Next.js 16, which has breaking changes.** Read `web/AGENTS.md` and the guides in `web/node_modules/next/dist/docs/` before writing frontend code.
- **Never commit `.env` files or `src/generated/`.** Both are gitignored.

## Not built yet

- The frontend. `web/` still shows the default Next.js page, and nothing calls the API.
- The ML service and the financial side of the score. `ml/` is empty, and the API has no route that talks to it. The climate profile is currently the only output.
- Authentication. `request_log.requester_id` exists but is always null.
- The World Bank flood exposure raster. `createClimateService` accepts an `exposure` provider, but none is passed, so every response carries a `flood_exposure_unavailable` warning and confidence is `med` at best.
- Agent-raised relevance. The `agent_raised` method and the `evidence_urls` and `agent_version` columns exist, but screening is rule-based only.
- Background jobs. Redis is configured for BullMQ, but forecasts are refreshed only when a request arrives.
- `severe` events for anything other than river flood, which would need ensemble forecasts.
- Dockerfiles, CI and deployment.
- CORS. A browser on another origin cannot call the API yet.

The thresholds and weights are starting assumptions and have not been tuned against real outcomes.
