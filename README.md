# Fusion Hackathon: Climate-Adjusted Financial Risk Score

A 24-hour hackathon project (Fusion 2026) that scores how exposed a small business in India is to climate hazards, so that the score can feed a financial risk assessment.

This README is the handover document for anyone, human or AI agent, picking up the repository cold. It describes what exists today, how it works, how to run it, and what is not built yet. AI agents should read `AGENTS.md` first: it holds the working rules, and points back here for the detail.

## Status at a glance

| Part | Folder | State |
| --- | --- | --- |
| Climate risk API | `api/` | Built and tested. 460 tests pass across `api/`; typecheck and lint are clean. |
| Climate agent | `api/src/services/climate/agent.ts` | Built. Optional: an OpenAI model reviews the screening and scores the forecast. Off without an API key. |
| Alert system | `api/src/services/alerts/` | Built. Email warnings to business owners and banks, sent by a separate worker process. SMS was removed (see `RESOLVE_LATER.md`). Triggered by the background monitor. |
| Background monitor | `api/src/services/climate/monitor/` | Built. Part of the climate unit, run as its own process. Watches locations with active loans, checks them more often when the forecast worsens, queues alerts and records events for the ML model. The loans DB and logs system it will read from and write to are stand-ins. |
| Demo page | `api/public/index.html` | Built. A single static page served by the API at `/demo/`. |
| Web frontend | `web/` | Untouched `create-next-app` scaffold. No project UI yet. |
| ML service | `ml/` | Dependencies declared only. No code, models, data or tests. |
| Postgres | `docker-compose.yml` | Used by the API as the durable store. |
| Redis | `docker-compose.yml` | Used by the API as a read cache in front of Postgres. No job queue yet. |

Everything of substance is in `api/`.

## Repository layout

```
fusion-hackathon/
├── docker-compose.yml      Postgres 16 and Redis 7 for local development
├── .dockerignore           Written ahead of time; there are no Dockerfiles yet
├── .claude/settings.json   Enables the ECC plugin for Claude Code
├── AGENTS.md               Working rules for AI coding agents
├── CLAUDE.md               One line that makes Claude Code load AGENTS.md
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

The first request for a new location downloads about 30 years of daily history from Open-Meteo and can take up to a minute. Later requests are served from Redis and Postgres.

The climate agent is off until you put an `OPENAI_API_KEY` in `api/.env`. Without it the API works the same way with rule-based results only. The startup log says which mode is running.

### Environment variables (`api/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `4000` | |
| `DATABASE_URL` | none, required | `postgresql://fusion:fusion@localhost:5432/fusion?schema=public` matches Docker Compose |
| `REDIS_URL` | `redis://localhost:6379` | Matches Docker Compose. The API still works when Redis is unreachable |
| `OPENAI_API_KEY` | none | Enables the climate agent. Blank means not set |
| `CLIMATE_AGENT_ENABLED` | `true` | Set to `false` to switch the agent off while keeping the key |
| `CLIMATE_AGENT_MODEL` | `gpt-5-nano` | OpenAI model the agent uses |

They are validated at startup by `api/src/config/env.ts`; the process exits if one is invalid. The alert system's variables (`ALERTS_*`, `SMTP_*`) are listed under [The alert system](#the-alert-system), and the monitor's (`MONITOR_*`) under [The background monitor](#the-background-monitor). Both sets are read separately, so a bad one never stops the API. Open-Meteo needs no key: its free tier is used without one.

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
| `npm run alerts:worker` | Runs the alert worker, a separate process that sends queued alerts |
| `npm run alerts:test` | Queues a test alert. Add `-- --seed` to create the demo business and contacts first |
| `npm run monitor` | Runs the background monitor, a separate process that checks watched locations and queues alerts |
| `npm run monitor:verify` | Labels past monitor events against observed weather. Runs once and exits |
| `npm run monitor:simulate` | Scripted demo of the monitor in its own database. Add `-- --location L1 --scenario heavy-rain` |

## What the API does

Given a latitude and longitude in India, the API returns a climate risk profile:

- an overall risk between 0 and 1, and a grade from A (lowest risk) to E;
- a score for each of six hazards: `river_flood`, `flash_flood`, `heat`, `drought`, `storm`, `cold_wave`;
- active events, raised when the 7-day forecast crosses a danger threshold;
- a confidence level and warnings that say which data sources were missing.

All weather data comes from [Open-Meteo](https://open-meteo.com). Postgres stores every response and is the durable copy. Redis sits in front of it as a faster read cache and holds nothing that Postgres or a new model call cannot replace.

When the climate agent is on, an OpenAI model does two jobs on top of the rules: it reviews each hazard's category after screening, and it sets the forecast part of each hazard's score. See [The climate agent](#the-climate-agent).

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/demo/` | MVP demo page (`api/public/index.html`) that calls the endpoints below |
| `GET` | `/health` | Service, database and upstream status |
| `POST` | `/climate/profile` | Full risk profile. Body: `{"lat": number, "lon": number}` |
| `GET` | `/climate/events?lat=..&lon=..` | Same pipeline, returning only location, active events, freshness, cache and warnings |
| `GET` | `/climate/cell/:cellId` | Debug view of what is stored for one grid cell, without raw payloads |
| `GET` | `/alerts?limit=..&business_id=..&status=..` | Recent alerts, newest first, each with its send attempts and the message as rendered. Never includes who it was sent to |

Request bodies are limited to 10 kB. There is no authentication.

`/health` returns 200 with `status: "ok"`, or `"degraded"` when the last Open-Meteo call failed, and 503 with `status: "down"` when Postgres is unreachable. It reports the outcome of the most recent real upstream call, so it never spends Open-Meteo quota. It does not report on Redis or the agent.

### Rate limits and idempotency

Both are applied to the whole app in `createApp`, so a new route gets them without extra code.

**Rate limits** are per client, over one minute. Every route allows 120 requests. `/climate/*` also has its own limit of 60, because one request there can cost several upstream calls. Responses carry the standard `RateLimit` headers. Over the limit, the answer is 429 `RATE_LIMITED`.

**Idempotency** applies to `POST`, `PUT`, `PATCH` and `DELETE`. Send an `Idempotency-Key` header (1 to 255 printable ASCII characters, no spaces) and a retry with the same key gets the first response back, with `Idempotency-Replayed: true`, without running the request again. The header is optional.

```bash
curl -X POST http://localhost:4000/climate/profile \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7c1f0a52-profile-guwahati' \
  -d '{"lat": 26.1445, "lon": 91.7362}'
```

- A stored response is replayed for 24 hours.
- A key belongs to one method and path. Reusing it there with a different URL or body returns 422 `IDEMPOTENCY_KEY_REUSED`.
- A retry that arrives while the first request is still running returns 409 `IDEMPOTENCY_IN_PROGRESS`. A request that never finishes holds its key for 5 minutes at most.
- 5xx and 429 responses are not stored, so the client can retry with the same key.
- Keys are kept in Postgres (`idempotency_keys`), so they hold across restarts. Expired rows are deleted at startup.

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
      "forecast_source": "agent",
      "forecast_note": "Two days near 40 mm, below the cell's 95th percentile for 3-day rain",
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

`hazards` always has all six hazards; the example shows one. `components.structural` only appears for the two flood hazards. `tripwire_promoted: true` appears on a hazard that is normally dormant but has an active event.

`relevance_method` is `agent_raised` when the agent moved a hazard to a higher category than the rules gave it; the agent's reason is then appended to `reason`. `forecast_source: "agent"` and `forecast_note` appear on every hazard when the agent set the forecast components, and are absent when the rule formula did.

`cache` is `miss` when a cell had to be screened, `partial_hit` when only some layers were refetched or the agent was called, and `complete_hit` when no outside call was made.

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
| 400 | `INVALID_IDEMPOTENCY_KEY` | `Idempotency-Key` is empty, too long or has spaces or non-ASCII characters |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | The first request with this key is still running |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The key was already used with a different URL or body |
| 404 | `NOT_FOUND` | Unknown route or method, or a valid cell with no data |
| 429 | `RATE_LIMITED` | Over 120 requests per minute, or over 60 on `/climate/*` |
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

When the agent is on, it then reviews the six categories. It can confirm a category or raise it, never lower it.

### 3. Fetch the current forecast (fast, cached for 6 hours)

The weather forecast and the river forecast are each cached for 6 hours and refetched once older than that. Dormant hazards cost almost nothing:

- only the two tripwire variables, `precipitation_sum` and `temperature_2m_max`, are always requested; other variables are added only for primary and secondary hazards;
- the river forecast is skipped entirely while `river_flood` is dormant.

A background job (`api/src/jobs/climate-refresh.ts`) also refetches the forecasts of every location the API has been asked about, every 6 hours, and updates scores and events from them. It handles one location at a time, fetches a shared cell once per run, and skips a location that fails. Its first run is 6 hours after startup, so restarting the server causes no burst of upstream calls.

The [background monitor](#the-background-monitor) is a different thing: a separate process that refetches the forecasts of watched locations on its own schedule and acts on what it finds.

### 4. Score

Each hazard has up to three components, each between 0 and 1:

- **structural**: built-in exposure of the exact point. Only the flood hazards have one. A point 10 m below its surroundings scores 1, and 10 m above scores 0.
- **historical**: the screening indicator. Reaching the primary threshold scores 0.5; twice the threshold scores 1.
- **forecast**: how close the next 7 days come to the hazard's danger level. A one-variable rule formula computes it; when the agent is on, the agent's score replaces it.

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
| The agent | Rule-based categories or forecast scores are used, with an `agent_unavailable` warning. Confidence is unchanged |
| Redis | Reads fall through to Postgres and writes are dropped. No warning; the outage is logged once |

Stale data is never served: an expired screening profile or a forecast past its 6 hours is refetched or left out, not reused. Each case adds an entry to `warnings`, except a Redis outage. Upstream calls are retried up to 3 times with backoff for timeouts, 429 and 5xx; other 4xx responses are not retried.

### Caching

| What | Redis key | Kept for | Durable copy |
| --- | --- | --- | --- |
| Screening result of a cell | `climate:relevance:<cell>` | Until the cell is due for re-screening (90 days, or 1 day if a source was missing) | `cell_hazard_relevance` |
| A forecast payload | `climate:response:<api>:<cell>:<hash>` | 6 hours | `climate_responses` |
| The agent's forecast scores | `climate:agent-forecast:<cells>:<hash>` | 6 hours | None; the agent is asked again |

All keys carry the prefix `fusion:`. An entry that does not match its expected shape is treated as a miss. Writes go to Postgres first, and the Redis entry is then rebuilt from what was stored.

## The climate agent

The agent is `createOpenAiAgent` in `api/src/services/climate/agent.ts`. It uses the OpenAI Responses API with structured output, and its two prompts are in `api/src/prompts/climate.ts`. It runs only when `OPENAI_API_KEY` is set and `CLIMATE_AGENT_ENABLED` is `true`.

| Call | When | What it does |
| --- | --- | --- |
| Screening review | Once per cell, after screening | Checks each rule-based category against what it knows of the place, to cover blind spots in gridded data such as cyclone gusts on a coast or a river the grid misses |
| Forecast scoring | Once per forecast refresh | Scores how threatening the next 7 days are for each hazard, from 0 to 1, using the rule score as a reference |

Limits placed on it:

- **It can raise a category, never lower it.** A lower verdict is recorded as agreement. A raised hazard gets `relevance_method: "agent_raised"` and the agent's reason.
- **Every reviewed category stores `agent_version`**, which is `<model>/<prompt version>`, for example `gpt-5-nano/agent-1`. Bump `CLIMATE.agent.promptVersion` in `src/config/climate.ts` whenever a prompt changes.
- **A failure never fails a request.** The rule-based result is used, and the agent is left alone for 5 minutes so a bad key does not slow every request.
- **A cell screened while the agent was off or failing is reviewed on a later request**, keeping its original re-screening date.
- **A reply must cover every hazard asked about.** One that is cut off, refused or incomplete counts as a failure. A forecast score is clamped to between 0 and 1.
- **Requests are sent with `store: false`**, so locations are not kept on OpenAI's side.

Events are still detected by the fixed thresholds in step 5. The agent has no say in them.

## The alert system

It warns a business owner and the bank when a sudden climate change is detected near a business, each with preventive steps. The full design is in `api/src/services/alerts/job.md`; this section says what was built and where it differs. The biggest difference: **alerts go out by email only.** The SMS channel in `job.md` was built and then removed, because the Twilio trial account refuses custom message text. `RESOLVE_LATER.md` item 5 says how to bring it back.

**The background monitor triggers it**: `npm run monitor` calls `enqueue()` once per affected business whenever a hazard rises. To queue an alert by hand, use the CLI:

```bash
cd api
npm run alerts:test -- --seed --business SME-0142 --hazard flood --severity WARNING
npm run alerts:worker     # in a second terminal; Ctrl+C stops it cleanly
curl 'http://localhost:4000/alerts?limit=5'
```

How it works:

- **Producers call one function.** `import { enqueue } from "./services/alerts/index.js"` and call `void enqueue(event)`. It does one `INSERT` into `alert_outbox`, resolves to `true` or `false` within milliseconds and never rejects, even when Postgres is down.
- **A separate process sends.** `npm run alerts:worker` polls the outbox every 15 seconds, claims up to 20 rows with a 2-minute lease, and sends them one at a time. The API never talks to SMTP.
- **Each event becomes two emails.** The owner gets one in their language (`en`, `hi` or `mr`) with preventive steps. The bank gets one with the borrower, the evidence and suggested actions; its `WATCH` alerts wait for one daily digest at 09:00 IST.
- **Rules applied by the worker** (`policy.ts`): no message without `consent_at`, or after `opted_out_at`; a 6-hour cooldown per business, hazard and audience that only a higher severity breaks; retries after 1, 2, 4 and 8 minutes, then `dead`.
- **Content is not code.** Guidelines are in `guidelines.json` and messages in `templates/`, read when the worker starts.
- **`ALERTS_MODE=dry_run` is the default.** Messages are logged and stored as sent without calling a provider. `ALERTS_ENABLED=false` turns `enqueue()` into a no-op and idles the worker.

An event is `{ businessId, hazard, severity, windowStart, windowEnd, evidence, sourceRunId }`. `hazard` is one of the six climate hazards or a generic `flood`; `severity` is `WATCH`, `WARNING` or `CRITICAL`. The same business, hazard, severity and `windowStart` is sent once however often it is queued.

| Variable | Default | Notes |
| --- | --- | --- |
| `ALERTS_ENABLED` | `true` | `false` switches the whole alert system off |
| `ALERTS_MODE` | `dry_run` | `live` sends through SMTP |
| `ALERTS_POLL_SECONDS` | `15` | |
| `ALERTS_COOLDOWN_HOURS` | `6` | |
| `ALERTS_TZ` | `Asia/Kolkata` | Timezone of the digest time |
| `ALERTS_DIGEST_TIME` | `09:00` | When the bank's daily `WATCH` digest goes out |
| `ALERTS_DASHBOARD_URL` | `http://localhost:3000` | Base of the borrower link in bank emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `ALERTS_FROM_EMAIL` | `smtp.gmail.com`, `587`, none | Needed in `live` mode |

Differences from `job.md`:

- No SMS: no Twilio sender, no SMS templates, no quiet hours and no email fallback. The `sms` channel value and the `phone_e164` column are still in the database, unused; the worker suppresses any `sms` row it finds.
- The code is in `api/src/services/alerts/`, not `src/alerts/`, and tests sit next to the code as `*.test.ts`.
- Storage is Postgres through Prisma, not SQLite. `alert_deliveries` also stores the rendered `subject` and `body`.
- A fourth table, `alert_businesses`, holds the name, city and sector that messages show, because the project has no business table yet.
- `Sender.send` takes one message object instead of `(to, subject, body)`, so it can say whether the body is HTML.

## The background monitor

It watches every location with an active loan and reacts when the forecast there suddenly worsens. It is part of the climate unit (`api/src/services/climate/monitor/`) and reuses its pipeline, grid, thresholds, agent and database, but it runs as its own processes and is never started inside the API. `api/src/services/climate/monitor/README.md` has the details; this section is the summary.

```bash
cd api
npm run monitor:simulate -- --location L1 --scenario heavy-rain   # safe demo, about 3 seconds
npm run monitor            # the real loop; Ctrl+C stops it cleanly
npm run monitor:verify     # daily: label past events against observed weather
```

How it works:

- **One loop, every 15 minutes.** Each tick reads the watched locations, groups them by the 0.1° forecast cell, and checks the cells that are due. A slow tick delays the next one; ticks never overlap.
- **The schedule is data.** Each cell's level, calm count and next check time are in `monitored_cells`, so a restart loses nothing. A cell is checked every 6 hours at `NORMAL`, every 3 at `WATCH`, and hourly at `WARNING` and `SEVERE`.
- **One call per cell.** A check calls the climate pipeline once with `forceFreshForecast`, which refetches only the weather and river forecasts, however many businesses are in the cell.
- **Rules decide.** Daily rain of 64.5, 115.6 or 204.5 mm with at least 25% probability gives `WATCH`, `WARNING` or `SEVERE`. Max temperature of 40 or 45 °C, and gusts of 60 or 90 km/h, give `WATCH` or `WARNING`. A river above its historical high is a `WARNING`, and `SEVERE` with heavy rain within 72 hours. A dormant hazard whose tripwire trips is at least a `WARNING`.
- **A sudden change is a hazard that rose since the last check.** The cell jumps to the new level, every business in it gets an alert through `enqueue()` (`SEVERE` is sent as `CRITICAL`), and a `disaster_events` row is stored as `pending`.
- **It calms down slowly.** A cell steps down one level only after two calm checks in a row.
- **The agent is optional and can only raise.** Off by default (`MONITOR_AGENT_ENABLED`). At most one review per cell every 6 hours; the final level is the higher of the rule level and the agent level.
- **Verification makes training data.** Five days after an event's window ends, `npm run monitor:verify` compares it with observed weather and labels it `hit` or `false_alarm`. Observed extremes that nothing forecast are added as `missed`.

| Variable | Default | Notes |
| --- | --- | --- |
| `MONITOR_ENABLED` | `true` | `false` makes the monitor processes idle |
| `MONITOR_TICK_MINUTES` | `15` | |
| `MONITOR_CONCURRENCY` | `5` | Cells checked at once |
| `MONITOR_AGENT_ENABLED` | `false` | Also needs `OPENAI_API_KEY` |
| `MONITOR_LOCATIONS_FILE` | `data/monitor-locations.json` | Watched locations, until the loans DB exists |
| `MONITOR_ALERT_SINK` | `outbox` | `console` prints alerts instead of queueing them |

Two things it depends on are not built, so they sit behind small interfaces in `monitor/ports.ts`: the list of active loans (a JSON file for now) and the logs system (the console for now). The monitor README gives the steps to swap each in.

## Code map (`api/`)

```
api/
├── prisma/schema.prisma          Database schema
├── prisma/migrations/            Four migrations: climate_tool, idempotency_keys, alerts, climate_monitor
├── data/monitor-locations.json   Locations the monitor watches, until the loans DB exists
├── prisma.config.ts              Prisma 7 config; the datasource URL lives here
├── public/index.html             Demo page, served at /demo/
├── vitest.config.ts              Points tests at a *_test database and Redis database 1; test files run one at a time
├── vitest.global-setup.ts        Applies migrations to the test database
└── src/
    ├── server.ts                 Entry point: connects, wires dependencies, listens
    ├── app.ts                    createApp(deps): rate limits, idempotency, routes
    ├── config/
    │   ├── env.ts                Validated environment variables
    │   ├── db.ts                 Prisma client, connectDb, disconnectDb
    │   ├── redis.ts              Redis client that fails fast when Redis is down
    │   └── climate.ts            Every tunable number in the pipeline and the agent
    ├── errors/app-error.ts       AppError and its 400/401/403/404/409 subclasses
    ├── middleware/
    │   ├── error-handler.ts      404 handler and the single error formatter
    │   ├── rate-limit.ts         rateLimiter(limit): per-client, one minute window
    │   └── idempotency.ts        Idempotency-Key handling and the in-memory store
    ├── routes/                   health.ts, climate.ts, alerts.ts
    ├── controllers/              climate.controller.ts, alerts.controller.ts: parse input, call the service
    ├── jobs/climate-refresh.ts   Six-hourly forecast refresh of every known location
    ├── prompts/climate.ts        The agent's two system prompts
    ├── generated/prisma/         Generated client. Gitignored; never edit
    └── services/
        ├── cache/cache.ts        Cache interface, Redis implementation, no-op cache
        ├── idempotency/prisma-store.ts   Postgres store for idempotency keys
        ├── alerts/
        │   ├── job.md                The design document
        │   ├── index.ts              enqueue(), the only function other modules call
        │   ├── enqueue.ts            Builds outbox rows; fast, never rejects
        │   ├── worker.ts             Entry point of npm run alerts:worker: claim, check, send, record
        │   ├── policy.ts             Cooldown, backoff, digest timing
        │   ├── render.ts             Templates + guidelines to message text
        │   ├── reader.ts             Read side behind GET /alerts
        │   ├── config.ts             ALERTS_* and SMTP_* settings, with safe defaults
        │   ├── cli.ts                npm run alerts:test
        │   ├── senders/              Sender interface, emailSmtp, dryRun
        │   ├── guidelines.json       Preventive steps by hazard, severity and audience
        │   └── templates/            One email per audience and language
        └── climate/
            ├── profile.service.ts    The pipeline: cache, fetch, review, score, save
            ├── agent.ts              ClimateAgent interface and the OpenAI agent
            ├── open-meteo.ts         HTTP client with retries, timeouts and validation
            ├── repository.ts         All database reads and writes
            ├── hazards.ts            Hazard catalog, thresholds and variable lists
            ├── screening.ts          Indicator to primary / secondary / dormant
            ├── scoring.ts            Component scores, overall risk, grade, events
            ├── stats.ts              Percentiles, rolling sums, indicators, projections
            ├── grid.ts               Cell snapping and cell id parsing
            ├── coordinates.ts        Input validation for lat and lon
            ├── schema.ts             Zod schemas of the response and of Redis entries
            ├── types.ts              Shared types
            ├── testing/              fake-open-meteo.ts, fake-agent.ts, memory-cache.ts
            └── monitor/              The background monitor
                ├── README.md             How it works, what it reuses, how to plug in the other units
                ├── index.ts              Entry point of npm run monitor
                ├── verifyJob.ts          Entry point of npm run monitor:verify
                ├── simulate.ts           Entry point of npm run monitor:simulate
                ├── container.ts          Wires the climate unit and the three ports
                ├── ports.ts              WatchedLocationSource, AlertSink, RunLogger, Clock
                ├── config.ts             MONITOR_* settings, with safe defaults
                ├── types.ts              Levels, findings, snapshot, cell state
                ├── cells.ts              Locations to forecast cells (pure)
                ├── rules.ts              The primary rules (pure)
                ├── cadence.ts            Level to interval, escalate and step down (pure)
                ├── verify.ts             hit / false_alarm / missed labelling (pure)
                ├── agentReview.ts        Optional agent review, raise-only
                ├── checkCell.ts          One cell: pipeline, rules, agent, decision
                ├── onSuddenChange.ts     Alert fan-out and the disaster event
                ├── tick.ts               One full tick: sync, claim, check, release
                ├── loop.ts               The awaited loop that never overlaps ticks
                ├── repo.ts               monitored_cells and disaster_events
                ├── adapters/             JSON locations, console alert sink and logger, clocks
                └── testing/fixtures.ts   Shared test fixtures and stubs
```

Where to change things:

- **A threshold, weight, cache lifetime or grid size**: `src/config/climate.ts`, or `LIMITS` and `HAZARD_CATALOG` in `hazards.ts`.
- **A monitor interval, rain class or timeout**: the `monitor` section of `src/config/climate.ts`. Heat, gust and cold thresholds are the climate unit's `LIMITS`.
- **The response shape**: `schema.ts`, then the object built at the end of `run()`. The schema is strict, so an extra key fails with `INVALID_OUTPUT`.
- **What the agent is told**: `src/prompts/climate.ts`, then bump `CLIMATE.agent.promptVersion`.
- **A rate limit**: `rateLimit` and `climateRateLimit` in `createApp`'s arguments; the defaults are in `app.ts`.
- **A new endpoint**: add a handler in a controller and register it in `routes/`. Throw an `AppError`; do not format error responses by hand. It inherits the global rate limit and idempotency; add a stricter limit in `app.ts` if a request is expensive.
- **A database column**: edit `schema.prisma`, then run `npm run db:migrate`.

## Database

Seventeen tables, defined in `api/prisma/schema.prisma`:

| Table | Holds |
| --- | --- |
| `hazard_catalog` | The six hazards and their rules. Seeded from code on the first request |
| `grid_cells` | One row per snapped cell |
| `points` | Each exact location requested, with its four cell ids |
| `point_static_features` | Elevation, relative elevation and flood exposure for a point |
| `cell_hazard_relevance` | Screening result per cell and hazard, with stored indicators, `review_after`, and `agent_version` once the agent has reviewed it |
| `climate_responses` | Raw Open-Meteo payloads. The durable cache behind Redis |
| `climate_metrics` | The same data normalised to one row per cell, date and variable |
| `hazard_scores` | Score history per point |
| `cell_events` | Events and their status: `open`, `escalated` or `closed` |
| `request_log` | Cache result and latency of each profile request. The background refresh is not logged; monitor checks are, with `requester_id` `climate-monitor` |
| `idempotency_keys` | One row per `Idempotency-Key`: the request fingerprint and, once finished, the stored response |
| `alert_outbox` | One row per alert to send, unique on dedupe key, audience and channel, with its status, attempts and lease |
| `alert_deliveries` | Every send attempt: provider, result, error and the message as rendered |
| `alert_contacts` | Who can be contacted, their language, and when they consented or opted out |
| `alert_businesses` | Name, city and sector of a business, as shown in alert messages |
| `monitored_cells` | One row per watched forecast cell: level, calm count, next check time, the last check's snapshot, and the lease of the monitor checking it |
| `disaster_events` | One row per sudden change the monitor detected, with the forecast values, and later the observed values and a `hit`, `false_alarm` or `missed` label |

A cached response is identified by cell, API name and a hash of the requested variables. Observed and projection metrics use the Unix epoch as `issued_at`, so refetching history never duplicates a day.

## Testing

```bash
cd api
npm test
```

- Tests run against a separate database. `vitest.config.ts` appends `_test` to the database name in `DATABASE_URL`, and the global setup applies migrations to it and refuses to run against a database whose name does not end in `_test`. Postgres must be running.
- Redis is separated the same way: tests use logical database 1 and development uses 0. Only `src/services/cache/cache.test.ts` talks to the real Redis, so Redis must be running too. Other tests use the in-memory cache in `testing/memory-cache.ts`.
- Tests never call Open-Meteo. `fakeOpenMeteo` generates synthetic history and forecasts, records which APIs were called, and can simulate outages through its `failing` option.
- Tests never call OpenAI. `testing/fake-agent.ts` stands in for the agent in pipeline tests, and `agent.test.ts` passes a stub client to `createOpenAiAgent`.
- `src/services/alerts/worker.test.ts` runs the alert worker against real Postgres with a fake email provider and a controllable clock. Tests never call SMTP.
- The route tests in `src/routes/climate.test.ts` are integration tests: the real Express app and real Postgres, with a controllable clock. They truncate all climate tables before each test.
- The monitor's tests are in `src/services/climate/monitor/`. The rules, cadence, cells and labelling are pure and need no database. `tick.test.ts` and `verifyJob.test.ts` use real Postgres with the climate pipeline stubbed, and `integration.test.ts` runs the monitor on the real pipeline with `fakeOpenMeteo`.
- Test files run one after another (`fileParallelism: false`), because the climate and monitor suites empty the same tables.
- The full run takes about two minutes, because a cache miss stores roughly 30 years of daily metrics.

Before handing work over, run `npm run typecheck`, `npm run lint` and `npm test`. All three pass today.

## Conventions

- **ES modules with NodeNext resolution.** Relative imports must end in `.js`, even though the files are `.ts`.
- **Strict TypeScript** with `noUncheckedIndexedAccess`: indexing an array gives `T | undefined`.
- **Dependencies are passed in, not imported.** `createApp(deps)` and `createClimateService(deps)` take the database, the Open-Meteo client, the cache, the agent, the idempotency store, the clock and the logger as arguments. Keep it that way; it is what makes the tests possible.
- **Every endpoint is rate limited and honours `Idempotency-Key`.** Both are mounted once in `createApp`, above the routes. Mount new routes below them.
- **Express 5.** A rejected promise in an async handler reaches the error handler without a wrapper.
- **Latitude always comes first**, in function arguments, cell ids and upstream requests.
- **Unused arguments** are prefixed with `_`.
- **API responses use snake_case**; TypeScript code uses camelCase; database columns are snake_case through Prisma `@map`.
- **Dates and timestamps are in IST** (`Asia/Kolkata`).
- **Comments are short** and explain why, not what.

## Things that will catch you out

- **Comments mention "README section 12", "section 17", "Call 6" and "Call 7".** They refer to the original climate tool specification, which was never committed, not to this file. Read `src/config/climate.ts` and `schema.ts` instead.
- **Fetch the archive before the climate projections, never at the same time.** Open-Meteo counts both against one per-minute limit, and a 30-year request uses all of it. When projections fail, the profile is still returned and they are retried 5 minutes later. A test protects this order.
- **A first lookup can fail with 503 when another heavy call ran in the same minute.** One 30-year archive request uses most of Open-Meteo's free per-minute allowance. The retries on a 429 all happen within about two seconds, so they cannot outlast the limit. Screening a second new city straight after the first is the usual trigger; waiting a minute and retrying works. Not fixed yet.
- **The per-cell lock is in-process.** It stops two simultaneous requests for a new cell from both downloading 30 years of history, but only inside one API instance.
- **So the monitor and the API do not share that lock.** They are separate processes. Both can refetch one cell's forecast at the same moment; the cost is a duplicated upstream call, since the writes are upserts. Two monitor instances are kept apart by leases in `monitored_cells`.
- **`npm run monitor` is not a dry run.** It calls Open-Meteo and queues alerts in the real outbox; with `ALERTS_MODE=live` and the worker running, those are emailed. Use `npm run monitor:simulate` or `MONITOR_ALERT_SINK=console` to look without sending.
- **The monitor's first run is slow on a cold cache.** Every new cell needs the 30-year download described above, about one per minute on the free tier. Rate-limited cells are retried on the next tick.
- **The simulator writes to its own database** (`<name>_sim`), which it creates and migrates on first use. It can be removed at any time.
- **The refresh job is in-process too.** It is a `setInterval`, not a queue. With several API instances, each one would run it.
- **Without Redis the agent is asked on every request.** Its forecast scores are cached only in Redis. If Redis is down, each profile request with a forecast calls the model again, which is slower and costs more.
- **Redis runs with `noeviction`** (set in `docker-compose.yml` for a future BullMQ queue). Cache entries all have a time to live, but if memory fills, writes fail and are dropped instead of evicting old keys.
- **Rate limiting is by IP address, counted in process memory, and `trust proxy` is not set.** Behind a reverse proxy, every client would share one limit; with several instances, each would count separately.
- **The `stale` value of `climate_responses.status` is unused.** Nothing writes it since stale data stopped being served. Expired screening rows stay in Postgres until the next re-screening overwrites them, and nothing reads them.
- **Prisma 7.** The client is generated into `src/generated/prisma` and uses the `@prisma/adapter-pg` driver adapter. The database URL is in `prisma.config.ts`, not in `schema.prisma`.
- **`web/` uses Next.js 16, which has breaking changes.** Read `web/AGENTS.md` and the guides in `web/node_modules/next/dist/docs/` before writing frontend code.
- **Run `npm run db:generate` after pulling a migration.** `prisma migrate dev` applied the alerts migration without regenerating the client, and every `prisma.alert*` call then fails to typecheck.
- **Alert content files are not copied to `dist/`.** `tsc` leaves `guidelines.json` and `templates/` behind, so a compiled worker reads them from `src/`. Ship `src/services/alerts/` content with any deployment.
- **Replying STOP does not update the database.** Emails tell people to reply STOP, but nothing reads replies. Set `alert_contacts.opted_out_at` by hand until an inbound webhook exists.
- **A bank digest covers at most 20 alerts.** The worker claims 20 rows per batch; more `WATCH` alerts than that go out as a second digest email.
- **Never commit `.env` files or `src/generated/`.** Both are gitignored.

## Not built yet

- The frontend. `web/` still shows the default Next.js page. The only UI is the static demo page at `/demo/`.
- The ML service and the financial side of the score. `ml/` is empty, and the API has no route that talks to it. The climate profile is currently the only output.
- Authentication. `request_log.requester_id` is null for every client request; only the monitor sets it.
- The World Bank flood exposure raster. `createClimateService` accepts an `exposure` provider, but none is passed, so every response carries a `flood_exposure_unavailable` warning and confidence is `med` at best.
- Evidence for agent decisions. The agent works from its own knowledge with no search or retrieval, so the `evidence_urls` column is always empty.
- The loans DB. The monitor reads its watched locations from `api/data/monitor-locations.json`, behind the `WatchedLocationSource` interface.
- The logs system. The monitor logs to the console, behind the `RunLogger` interface.
- A schedule for `npm run monitor:verify`. It runs once and exits; nothing runs it daily yet.
- Alerts when a hazard score rises a band. `job.md` section 3 lists that trigger; the monitor acts on forecast thresholds and dormant tripwires only.
- A way to manage alert contacts and businesses. They are rows written by hand or by `npm run alerts:test -- --seed`.
- SMS alerts. Removed for now; see `RESOLVE_LATER.md` item 5.
- Native-speaker review of the Hindi and Marathi alert texts.
- A job queue. The forecast refresh runs on a timer inside the API process; Redis is configured for BullMQ, but BullMQ is not installed.
- Handling of Open-Meteo's rate limits: waiting out a 429, queueing heavy calls, or pre-warming the demo cities.
- Shared state for several API instances: the cell lock, the refresh job and the rate limit counters are all per process. The same goes for the cell lock between the API and the monitor.
- `severe` events for anything other than river flood, which would need ensemble forecasts.
- Dockerfiles, CI and deployment.
- CORS. A browser on another origin cannot call the API yet.

The thresholds and weights are starting assumptions and have not been tuned against real outcomes.
