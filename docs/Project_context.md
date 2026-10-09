# Fusion Hackathon: Climate-Adjusted Financial Risk Score

A 24-hour hackathon project (Fusion 2026) that scores how exposed a small business in India is to climate hazards, so that the score can feed a financial risk assessment.

This README is the handover document for anyone, human or AI agent, picking up the repository cold. It describes what exists today, how it works, how to run it, and what is not built yet. AI agents should read `AGENTS.md` first: it holds the working rules, and points back here for the detail.

## Status at a glance

| Part | Folder | State |
| --- | --- | --- |
| Climate risk API | `api/` | Built and tested. 890 tests pass across `api/`; typecheck and lint are clean. |
| Climate agent | `api/src/services/climate/agent.ts` | Built. Optional: an OpenAI model reviews the screening and scores the forecast. Off without an API key. |
| Alert system | `api/src/services/alerts/` | Built. Email warnings to business owners and banks, sent by a separate worker process. SMS was removed (see `RESOLVE_LATER.md`). Triggered by the background monitor. |
| Background monitor | `api/src/services/climate/monitor/` | Built. Part of the climate unit, run as its own process. Watches the businesses with an authorised or active loan in the input service's tables, checks them more often when the forecast worsens, queues alerts and records events for the ML model. The logs system it will write to is a stand-in. |
| Finance service | `api/src/services/finance/` | Built. Baseline financial health score and a climate-adjusted score per business, from the input service's data and the climate profile. Rule-based; the ML scorer is a stub. Has its own `README.md`. |
| Evaluator | `api/src/services/evaluator/` | Built. Checks the climate and finance answers for one business against each other and against their own rules, gives one combined rating with reasons, and stores each evaluation. The chat advisor reads climate and finance only through it. See [The evaluator](#the-evaluator). |
| Chat advisor | `api/src/services/advisor/` | Built on the `chatbot-work` branch and merged. Mounted at `/advisor` for signed-in users, with the input service's ownership and sharing rule; bank decisions need a bank officer. Its `/advisor/dev/*` routes (fake alert, verify, sweep) are for bank officers only, exist only when `ADVISOR_ENABLE_DEV_ROUTES=true` and never in production. Runs an offline planner without an API key. Reads businesses, snapshots, loans and weather-impact profiles from the input service and scores from the finance service; the `api/data/smes.json` demo businesses stay behind them outside production. Advises owners after each alert the alert system sends. Its `NOTES.md` has the details. |
| Web console | `web/` | Built. A static HTML, CSS and JavaScript page with no build step. It walks one loan through every unit on a single page and calls every endpoint; see [The web console](#the-web-console). Checked against the live API only as far as the public routes and the 401 answers; the signed-in flows have not been exercised from it yet. |
| ML service | `ml/` | A separate FastAPI service, started by hand: alert calibration for flood and storm, cash-flow anomaly detection and a climate cash-flow simulation. The API reaches it through `/ml` (see [The ML endpoints](#the-ml-endpoints)); the monitor and the finance score do not use it yet. Model cards are in `ml/models/`, assumptions in `ml/data/ASSUMPTIONS.md`. |
| Postgres | `docker-compose.yml` | Used by the API as the durable store. |
| Redis | `docker-compose.yml` | Used by the API as a read cache in front of Postgres. No job queue yet. |

Everything of substance is in `api/`.

New to the app? [docs/README.md](docs/README.md) says what a business owner, a bank officer and the operator each do, and walks one loan through it.

## Repository layout

```
fusion-hackathon/
├── docker-compose.yml      Postgres 16 and Redis 7 for local development
├── .dockerignore           Written ahead of time; there are no Dockerfiles yet
├── .claude/settings.json   Enables the ECC plugin for Claude Code
├── AGENTS.md               Working rules for AI coding agents
├── CLAUDE.md               One line that makes Claude Code load AGENTS.md
├── api/                    Express + TypeScript + Prisma API (the real work)
├── web/                    Static console for every unit: index.html, styles.css, app.js, sample-data.js
├── landing/                Product landing page: Vite + React + TypeScript, with the demo video
└── ml/                     Python project (FastAPI, scikit-learn): data, features, training, models, service, tests
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

Or open the web console in `web/`; see below.

### The web console

`web/` is one static page that follows a single loan through every unit, in order: sign in, the business applies, its weather-impact profile, climate risk at its location, financials, the loan and its finance profile, authorisation and the alert outbox, then an event and the advisor. The advisor chat stays docked beside the steps. It has no dependencies and no build step.

```bash
# from the repository root, with the API running on port 4000
python3 -m http.server 3000 --directory web
```

Open http://localhost:3000. The port matters: `http://localhost:3000` is the default in `AUTH_ALLOWED_ORIGINS`, and the API refuses writes from any other origin. To sign in from it, add `http://localhost:3000` to the OAuth client's authorised JavaScript origins.

- **Run the whole workflow.** The button at the top submits the main form of each step in turn (`WORKFLOW` in `web/app.js`) and stops at the first one the API refuses, showing the answer in that step. Creating a loan and authorising it need a bank officer. The secondary endpoints of each step sit under its "More" fold.
- **The advisor step continues with the same business.** Creating the business and recording the loan fill their ids into the chat and the step 08 forms. Before that, the chat uses `SME-0142`, a demo business from `api/data/smes.json`.
- **Live and sample modes.** The page probes `GET /health` on load. If the API does not answer it switches to sample mode, where nothing is sent and every step answers with synthetic data from `web/sample-data.js`, each answer labelled as a sample. The data follows one made-up business, Sri Lakshmi Bakery in Chennai, and writes move a state kept in the page (loan status, advisor state, alert outbox, repayment proposal), so the whole workflow can be walked without the API; a reload starts it again. The figures imitate the services' rules and are not computed by them. The mode button in the header switches back.
- **Wire log.** The bar at the bottom lists every request the page made, with its status, time, `RateLimit` header, `Idempotency-Key`, whether it was replayed, and `X-Request-Id`.
- **Adding an endpoint to it** needs no JavaScript for a plain form: give a `<form>` a `data-call="METHOD /path/:param"` attribute and name its inputs after the body fields. The comment at the top of `web/index.html` lists the conventions. A bespoke view is a function in `RENDER` in `web/app.js`; without one the answer is drawn as plain fields.
- The `.next` folder, `node_modules` and `next-env.d.ts` in `web/` are ignored leftovers of the removed Next.js scaffold and are not used.

### The landing page

`landing/` is the product page: the problems Kshetra addresses, how each service answers them, the worked bakery example, the safety limits and the current status, with a 30-second demo video of the sample workflow (`landing/public/kshetra-demo.mp4`). It is a Vite + React + TypeScript project, light theme only, and separate from the console, which keeps its no-build rule.

```bash
cd landing
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck, then a static build in landing/dist
```

Its "Open the console" buttons go to `VITE_CONSOLE_URL` (`landing/.env.example`), `http://localhost:3000/` by default. The copy lives in `landing/src/content.ts`; the bakery figures are the sample mode's synthetic ones. Keep its status table in step with "Status at a glance" above.

The first request for a new location downloads about 30 years of daily history from Open-Meteo and can take up to a minute. A location saved through the input service is warmed with 15 years instead (see "How the services connect"). Later requests are served from Redis and Postgres.

The climate agent is off until you put an `OPENAI_API_KEY` in `api/.env`. Without it the API works the same way with rule-based results only. The startup log says which mode is running.

### Environment variables (`api/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `4000` | |
| `DATABASE_URL` | none, required | `postgresql://fusion:fusion@localhost:5432/fusion?schema=public` matches Docker Compose |
| `REDIS_URL` | `redis://localhost:6379` | Matches Docker Compose. The API still works when Redis is unreachable |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the API. Set it when deployed behind one; at `0` there, every client shares one rate limit |
| `OPENAI_API_KEY` | none | Enables the climate agent. Blank means not set |
| `CLIMATE_AGENT_ENABLED` | `true` | Set to `false` to switch the agent off while keeping the key |
| `CLIMATE_AGENT_MODEL` | `gpt-5-nano` | OpenAI model the agent uses |
| `GOOGLE_CLIENT_ID` | none | OAuth client ID for Sign in with Google. Blank means nobody can sign in, so every protected route answers 401 |
| `AUTH_BANK_EMAILS` | none | Comma-separated emails of bank officers |
| `AUTH_BANK_DOMAINS` | none | Comma-separated email domains whose users are all bank officers |
| `AUTH_ROLES_ENFORCED` | `true` | `false` gives every signed-in user the bank role and ignores the two lists above. Only an exact `false` switches roles off, and it is ignored when `NODE_ENV=production` |
| `AUTH_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated frontend origins allowed to call the API with the session cookie. `*` allows every origin, for local demos only; it is ignored when `NODE_ENV=production` |
| `AUTH_COOKIE_SAMESITE` | `lax` | `lax` or `none`. Use `none` when the frontend is on a different site from the API; the cookie is then also `Secure`, so it needs HTTPS |

| `FINANCE_SCORER` | `rules` | `rules` or `ml`. `ml` sends the metrics to `FINANCE_ML_URL` and falls back to the rules if the call fails |
| `FINANCE_ML_URL` | none | Scoring endpoint of the Python model, which is not built yet |
| `ML_SERVICE_URL` | none | Base URL of the Python service in `ml/`, for example `http://localhost:8001`. Without it `/ml` answers 503 `ML_UNAVAILABLE` |

The first seven are validated at startup by `api/src/config/env.ts`; the process exits if one is invalid. The sign-in variables (`GOOGLE_CLIENT_ID`, `AUTH_*`) are read by `api/src/services/auth/config.ts` and are described under [Authentication](#authentication). The finance service's (`FINANCE_*`) are read by `api/src/services/finance/config.ts`. The alert system's variables (`ALERTS_*`, `SMTP_*`) are listed under [The alert system](#the-alert-system), the monitor's (`MONITOR_*`) under [The background monitor](#the-background-monitor), and the advisor's (`ADVISOR_*`) in `api/src/services/advisor/NOTES.md`. All of these are read separately, so a bad one never stops the API. Open-Meteo needs no key: its free tier is used without one.

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

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | anyone | Service, database and upstream status |
| `GET` | `/auth/config` | anyone | `{ "google_client_id": ... }`, which a frontend needs to draw the sign-in button. `null` when sign-in is not configured |
| `POST` | `/auth/google` | anyone | Sign in. Body: `{"credential": "<Google ID token>"}`. Sets the session cookie and returns `{ user }` |
| `GET` | `/auth/me` | signed in | The signed-in user: `id`, `email`, `name`, `picture_url`, `role` |
| `POST` | `/auth/logout` | anyone | Ends the session and clears the cookie. Answers 204 |
| `POST` | `/climate/profile` | signed in | Full risk profile. Body: `{"lat": number, "lon": number}` |
| `GET` | `/climate/events?lat=..&lon=..` | signed in | Same pipeline, returning only location, active events, freshness, cache and warnings |
| `GET` | `/climate/cell/:cellId` | signed in | Debug view of what is stored for one grid cell, without raw payloads |
| `GET` | `/alerts?limit=..&business_id=..&status=..` | bank | Recent alerts, newest first, each with its send attempts and the message as rendered. Never includes who it was sent to |

| `GET` | `/finance/business/:id/profile` | owner of it, bank | Finance profile: baseline score, stress test per hazard, climate-adjusted score and drivers. Stores each one |
| `GET` | `/finance/business/:id/profiles` | owner of it, bank | Stored finance profiles of a business, newest first |
| `POST` | `/finance/business/:id/scenario` | owner of it, bank | Stress test for a hypothetical event. Body: `{"hazard", "severity", "duration_months"?}` |
| `POST` | `/finance/business/:id/repayment-capacity` | owner of it, bank | Largest affordable EMI and monthly shortfall. Body: `{"revenue_drop_pct", "months"}` |
| `GET` | `/evaluate/business/:id` | owner of it, bank | Evaluation of the business's climate and finance answers: checks, combined rating, reasons, the climate profile and a finance summary. Stores each one |
| `GET` | `/evaluate/business/:id/history` | owner of it, bank | Stored evaluations of a business, newest first |
| `POST` | `/finance/evaluate-location` | signed in | Scores an unsaved business at a candidate location. Body: `{"business", "lat", "lon"}` |
| `GET` | `/finance/demo` | signed in | Runs a built-in sample business through the finance pipeline |
| `GET` | `/ml/status` | signed in | Whether the Python service answers and which models it has loaded. Always 200 |
| `POST` | `/ml/alerts/calibrate` | signed in | Chance that a fired flood or storm alert is followed by a real event |
| `POST` | `/ml/anomaly` | signed in | Whether a monthly revenue series breaks from its own pattern |
| `POST` | `/ml/climate-cashflow` | signed in | Simulated effect of the location's weather on a business's default risk |

The input service's routes (`/businesses`, `/loans`, `/seed`) are listed in `api/src/services/input/README.md`. All of them need a signed-in user. The finance routes, their bodies and the profile's shape are described in `api/src/services/finance/README.md`.

Request bodies are limited to 10 kB.

`/health` returns 200 with `status: "ok"`, or `"degraded"` when the last Open-Meteo call failed, and 503 with `status: "down"` when Postgres is unreachable. It reports the outcome of the most recent real upstream call, so it never spends Open-Meteo quota. It does not report on Redis or the agent.

### Authentication

Users sign in with Google. There are no passwords and no API keys.

1. The frontend shows Google's Sign in with Google button, using the client ID from `GET /auth/config`.
2. Google gives the browser an ID token. The frontend posts it to `POST /auth/google`.
3. The API verifies the token's signature, expiry, issuer and audience with `google-auth-library`, and refuses an account whose email Google has not verified.
4. It creates or updates a row in `users`, creates a row in `sessions`, and sets the cookie `fusion_session`.
5. The browser sends the cookie with each later request. A frontend on another origin must use `fetch(url, { credentials: "include" })`.

**Sessions.** The cookie holds a random 32-byte token and is `httpOnly`, so scripts on the page cannot read it. Postgres stores only the token's SHA-256 hash. A session ends 7 days after sign-in and is not extended by use. `POST /auth/logout` deletes it. Expired rows are deleted at startup.

**Roles.** A user is either an `owner` or a `bank` officer. The role is not stored: on every request it is worked out from the user's email and the `AUTH_BANK_EMAILS` and `AUTH_BANK_DOMAINS` settings, so changing those settings and restarting the API changes existing sessions too. Everyone not listed is an owner.

With `AUTH_ROLES_ENFORCED=false` there is no split: every signed-in user is a bank officer, so they can call every route and open every business. Signing in is still required. The API prints a warning at startup while this is on, and ignores the setting when `NODE_ENV=production`. It is meant for the period before bank officers are named, not for a deployment that holds real data.

| Role | Can do |
| --- | --- |
| Not signed in | `/health`, `/auth/config`, `/auth/google`, `/auth/logout` |
| `owner` | `/climate/*`, and the businesses they created through `POST /businesses` |
| `bank` | Everything an owner can, every business shared with the bank, `/alerts`, the bank-only input routes and `POST /seed/smes` |

An owner who asks for another owner's business gets 404 `BUSINESS_NOT_FOUND`, the same answer as for a business that does not exist. Seeded businesses and businesses created by a bank officer have no owner, so only bank officers can open them. A bank officer who asks for a business whose owner did not agree to share it (`consent.share_with_bank` is `false`) gets the same 404.

**Once a loan is authorised or active**, the business's profile, operations, locations and suppliers can be changed by a bank officer only; the owner gets 403 `LOCKED_BY_LOAN`. These are what the risk is worked out from, and the primary location decides which cell the monitor watches. The owner can still change contacts and add financial snapshots.

**Audit trail.** Every answer carries an `X-Request-Id`. One row goes to `audit_events` for each write (`POST`, `PUT`, `PATCH`, `DELETE`), each refusal (401 or 403) and each failed attempt to open a business: the request id, the user id and role, the action as method and route (`PUT /businesses/:id/locations`), the record it was about, the outcome (`success`, `denied` or `failure`), the status and the error code. Request bodies, tokens and financial values are never stored. Plain reads and rate-limited requests are not recorded. The table is append only: a database trigger refuses `UPDATE` and `DELETE`. There is no endpoint that reads it; query the database.

**Requests from other websites.** Because the session is a cookie, the API checks the `Origin` header that browsers attach. Origins in `AUTH_ALLOWED_ORIGINS` get CORS headers with credentials allowed. A `POST`, `PUT`, `PATCH` or `DELETE` from any other origin is refused with 403 `ORIGIN_NOT_ALLOWED`. Setting it to `*` turns this check off so any local page can sign in; that also turns off the CSRF protection, so it is ignored in production. Requests with no `Origin` header (curl, other servers) and pages the API serves itself are not affected.

**Setting it up.** In Google Cloud Console, create an OAuth client ID of type "Web application". Add each frontend origin, such as `http://localhost:3000` for the web console, to its authorised JavaScript origins. Put the client ID in `GOOGLE_CLIENT_ID`. Until it is set, `POST /auth/google` answers 503 `AUTH_NOT_CONFIGURED`.

To call a protected route with curl, sign in on the web console and copy the `fusion_session` cookie from the browser's developer tools:

```bash
curl -X POST http://localhost:4000/climate/profile \
  -H 'Content-Type: application/json' \
  -H 'Cookie: fusion_session=<value>' \
  -d '{"lat": 26.1445, "lon": 91.7362}'
```

### Rate limits and idempotency

Both are applied to the whole app in `createApp`, so a new route gets them without extra code.

**Rate limits** are per client, over one minute. Every route allows 120 requests per address. The per-route limits below count per signed-in user, so an account cannot reset its limit by changing address. `/climate/*` also has its own limit of 60, because one request there can cost several upstream calls, `/auth/*` has a limit of 20, `/finance/*` has a limit of 30, because a profile can cost a climate lookup, `/evaluate/*` has a limit of 30 for the same reason, and `/advisor/*` has a limit of 30. Inside it, `POST /advisor/chat` and `POST /advisor/damage-report` together allow 5 requests per user, because each one is an answer from the agent and can cost several model calls. Responses carry the standard `RateLimit` headers. Over the limit, the answer is 429 `RATE_LIMITED`.

**Idempotency** applies to `POST`, `PUT`, `PATCH` and `DELETE`. Send an `Idempotency-Key` header (1 to 255 printable ASCII characters, no spaces) and a retry with the same key gets the first response back, with `Idempotency-Replayed: true`, without running the request again. The header is optional.

```bash
curl -X POST http://localhost:4000/climate/profile \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7c1f0a52-profile-guwahati' \
  -H 'Cookie: fusion_session=<value>' \
  -d '{"lat": 26.1445, "lon": 91.7362}'
```

- A stored response is replayed for 24 hours.
- A key belongs to one user, method and path, so one user is never sent another user's stored response. Reusing it there with a different URL or body returns 422 `IDEMPOTENCY_KEY_REUSED`.
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
| 401 | `UNAUTHORIZED` | A protected route was called without a session, or the session has ended |
| 401 | `INVALID_CREDENTIAL` | `POST /auth/google` got a token that Google did not issue for this app, or that has expired |
| 403 | `EMAIL_NOT_VERIFIED` | The Google account's email is not verified |
| 403 | `FORBIDDEN` | A bank-only route was called by an owner |
| 403 | `ORIGIN_NOT_ALLOWED` | A write came from a website that is not in `AUTH_ALLOWED_ORIGINS` |
| 404 | `NOT_FOUND` | Unknown route or method, or a valid cell with no data |
| 409 | `NO_FINANCIALS` | A finance profile was asked for a business with no financial snapshot |
| 429 | `RATE_LIMITED` | Over 120 requests per minute, over 60 on `/climate/*`, over 20 on `/auth/*`, or over 30 on `/finance/*` |
| 503 | `AUTH_NOT_CONFIGURED` | `GOOGLE_CLIENT_ID` is not set |
| 503 | `AUTH_UNAVAILABLE` | Google's signing keys could not be downloaded |
| 503 | `UPSTREAM_UNAVAILABLE` | Weather history could not be fetched and nothing is cached |
| 500 | `INVALID_OUTPUT` | The generated profile failed its own schema check |
| 403 | `LOCKED_BY_LOAN` | An owner tried to change the profile, operations, locations or suppliers of a business with an authorised or active loan |
| 500 | `INTERNAL_ERROR` | Anything unexpected. The message is always `Internal server error`; the detail is in the server log beside the request id |

Validation runs in a fixed order: presence, type, range, coverage. Coordinates are rounded to 4 decimal places, about 10 metres.

## The ML endpoints

`/ml` is how a frontend reaches the Python models in `ml/`. The Python service has no sign-in or rate limit of its own, so keep it reachable from the API only. `/ml` adds the session check, a limit of 30 requests a minute per client (`ML.rateLimit` in `src/services/ml/config.ts`), strict request validation and an 8-second timeout. Nothing is stored: each answer is computed from the request alone.

Start the Python service and point the API at it:

```bash
cd ml && uvicorn app.main:app --port 8001      # with ml/requirements.txt installed
# in api/.env
ML_SERVICE_URL=http://localhost:8001
```

**`POST /ml/alerts/calibrate`** Body: `hazard` (`flood` or `storm`), `lat`, `lon`, `date` (`YYYY-MM-DD`), `precipitation_sum` (1 to 60 daily values ending on the alert day, oldest first), and optionally `soil_wetness_top`, `relative_humidity_2m_mean`, `wind_speed_10m_max` and `surface_pressure_mean` in the same form. Storm needs the last two; without them the band is `baseline`.

```json
{ "p_event": 0.345, "band": "high", "model_version": "alert-cal-0.2.0", "cell": "Mumbai", "distance_km": 3.1, "reason": null }
```

`band` is `low`, `medium` or `high`; `baseline` when only the rule's base rate applies; `unscored` when the point is more than 150 km from a trained cell. Treat `baseline` and `unscored` as "show the alert as it is".

**`POST /ml/anomaly`** Body: `monthly_revenue` (13 to 120 values, oldest first), and optionally `late_payments` (booleans, same length), `cell_anomalous_share` (0 to 1) and `climate_event_in_cell`.

```json
{ "anomaly_score": 0.63, "flagged": true, "type": "systemic", "months_flagged": 2, "model_version": "cashflow-anomaly-0.1.0", "reason": null }
```

`type` is `systemic` (shared with the area, likely weather), `idiosyncratic` (this business alone) or `null` when not flagged. The stored financial snapshots hold 6 to 12 months, so a business needs more history than the input service keeps today.

**`POST /ml/climate-cashflow`** Body: `lat`, `lon`, `monthly_revenue`, `variable_cost_share` (0 to 0.95), `fixed_costs`, `emi`, `starting_cash`, and a `sector` or a `vulnerability` (0 to 1 per hazard). Optional: `revenue_volatility`, `insurance_recovery`, `backup_power`, `date`, `pd_base` (the scorecard's PD, to get `climate_adjusted_pd` back), and `alert_hazard` with `alert_p_event` for an active alert.

```json
{
  "scored": true, "cell": "Guwahati", "distance_km": 4.2,
  "pd_without_climate": 0.0006, "pd_with_climate": 0.2203, "delta_pd_climate": 0.2197,
  "climate_adjusted_pd": 0.2597, "climate_premium_bps": 988.7,
  "expected_annual_climate_loss": 132007, "climate_cfar95": 405868, "cash_reserve_target": 345868,
  "p_cash_short_30d": 0.05, "p_cash_short_30d_without_climate": 0.0,
  "loss_by_hazard": { "river_flood": 90000 },
  "what_if": [{ "condition": "insure 50% of climate losses", "pd_with_climate": 0.0618, "pd_change": -0.1585 }],
  "paths": 20000, "hazards": { "river_flood": { "events_per_year": 2.86, "mean_duration": 16.14 } },
  "assumptions": ["..."]
}
```

A point with no measured cell within 150 km answers `{ "scored": false, "reason": "..." }`. Show `assumptions` next to the numbers: the size of the effect depends on assumed costs per event (`ml/data/ASSUMPTIONS.md`).

| Status | Code | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, unknown or out of range; `details` lists each one |
| 502 | `ML_FAILED` | The Python service failed or sent an answer the API does not recognise |
| 503 | `ML_UNAVAILABLE` | `ML_SERVICE_URL` is not set, or the service did not answer in time |

## How the services connect

The input service holds the real businesses, locations, snapshots and loans. Every other unit reads them; none keeps its own copy.

```
input service ──climate_warm──▶ climate pipeline           (cache warm-up, 15 years of history)
      │ ──finance triggers────▶ finance service            (first profile, recompute)
      ├─ authorised/active loans ─▶ monitor ──enqueue()──▶ alert outbox ──▶ alert worker ──▶ email
      │                                                         │ owner rows that were sent
      └─ businesses, snapshots, loans, impact ─▶ advisor ◀──────┘ (loan → ALERT, ranked actions)
                                                     ▲ getEvaluation
                       climate pipeline + finance service ─▶ evaluator (checks, rating, stored)
```

- **Climate warm-up.** `server.ts` connects the input service's `climate` port: a saved or moved primary location calls `getProfile` with `historyYears: 15` (`CLIMATE.warmHistoryYears`). The archive and river history then start on 1 January 15 years back, never before `CLIMATE.historyStart`. The screening is cached per cell, so a cell first screened this way keeps the 15-year screening for API callers too until it is reviewed again (90 days). A warm-up that fails stays a pending job and is retried with the input service's other pending work.
- **Finance triggers.** Unchanged: an authorised loan and a new snapshot on a live loan each store a fresh finance profile.
- **Monitor.** `MONITOR_LOCATION_SOURCE=input` (the default) watches the primary location of every business with an `authorised` or `active` loan, read again on every tick. `json` reads `MONITOR_LOCATIONS_FILE` instead; `monitor:simulate` always reads the file.
- **Alerts.** The worker looks a business up in `alert_businesses` first and then in the input service's `businesses` (city from the primary location's PIN code). An owner with no row in `alert_contacts` is emailed at `contacts.owner.email` only when `consent.alerts` is true and `email` is one of `contacts.alerts.channels`. Any owner row in `alert_contacts`, opted out or not, decides instead. Bank alerts still go to the consenting bank rows in `alert_contacts`; the per-business bank officer is not added, because a bank digest covers several businesses.
- **Evaluator.** Asks the climate unit and the finance service about one business, checks the two answers and rates them together. See [The evaluator](#the-evaluator).
- **Advisor.** Reads each business from the input service (`advisor/inputDirectory.ts`). It reaches the climate unit and the finance service only through the evaluator, with one tool, `getEvaluation`; a failed check means no verdict. Every `/advisor` route that names a business or loan applies the input service's access rule: owners see their own businesses, the bank sees those shared with it. Every 60 seconds (`ADVISOR_SWEEP_SECONDS`) it takes the owner alerts the worker **sent** in the last 48 hours, so consent, opt-out and cooldown have already been applied, and advises on each once (`advisor/monitorAlerts.ts`): live loans move to `ALERT` and the owner gets ranked actions. That is a second message to the owner after the alert email; `ADVISOR_MONITOR_ALERTS=false` turns it off. The advisor sends these itself, not through the outbox: `ALERTS_REDIRECT_TO` applies to them too, but the outbox's cooldown does not. The bank's copy goes only to the bank contacts in `alert_contacts`, never to the bank officer address an owner typed.

## The evaluator

`api/src/services/evaluator/`. One call, `evaluate({ businessId })`, for a business of the input service:

1. Reads the business's primary location and latest snapshot version from the input service.
2. Asks the climate unit for the profile at that location.
3. Takes the finance service's latest stored profile when it is current: built from the latest snapshot, by the current `FINANCE.modelVersion`, less than 24 hours ago. Otherwise it asks for a new one, which the finance service stores as usual. A chat turn therefore does not add a finance profile each time.
4. Runs twelve checks. Each is `pass`, `warn`, `fail` or `skip`:

| Check | Fails or warns when |
| --- | --- |
| `climate_available`, `finance_available` | Fails when the unit could not answer (a business with no snapshot has no finance profile) |
| `climate_schema`, `finance_schema` | Fails when the answer does not match its strict schema |
| `climate_confidence` | Warns when the climate unit's confidence is `low` |
| `forecast_fresh` | Warns when the forecast run is older than 12 hours, or there is none |
| `finance_current` | Fails when the finance profile was built from an older snapshot than the latest |
| `snapshot_verified` | Warns when the bank has not verified the snapshot |
| `same_location` | Fails when finance was stress-tested on a different forecast cell; warns when it has no climate adjustment |
| `same_climate_run` | Warns when the forecast has been refreshed since finance was stress-tested on it |
| `stress_coverage` | Warns when no hazard was stress-tested although a climate profile exists |
| `adjustment_cap` | Fails when the adjusted score is more than `FINANCE.adjusted.maxUplift` above the baseline |

5. Rates the business: `favourable`, `acceptable`, `caution`, `unfavourable` or `insufficient_data`. The rating comes from a table of the finance band (the climate-adjusted one when there is one) against the climate grade, in `EVALUATOR.rating` (`evaluator/config.ts`). A stress test that breached lowers a better rating to `caution`. Any failed check, or a missing side, gives `insufficient_data` and `reliable: false`.
6. Writes `reasons`: failed checks first, then the scores, breaches and drivers, the climate grade and primary hazards, and caveats from warnings.
7. Validates the evaluation against a strict schema and stores it in `evaluations`.

The advisor's demo businesses (`smes.json`) are not in the input service. For them only the climate side is evaluated; the finance checks are `skip` and the rating is `insufficient_data`, but `reliable` stays true, so the advisor still advises from the climate profile and its own cash-flow maths. Settings are in `EVALUATOR`; bump `EVALUATOR.version` when a check or the table changes.

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

- **Producers call one function.** Build it once with `createEnqueue({ prisma, config })` from `./services/alerts/enqueue.js` and call `void enqueue(event)`. It does one `INSERT` into `alert_outbox`, resolves to `true` or `false` within milliseconds and never rejects, even when Postgres is down.
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
- A fourth table, `alert_businesses`, holds the name, city and sector that messages show. It came before the input service's `businesses` table and is now asked first, with `businesses` behind it (see "How the services connect").
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
| `MONITOR_LOCATION_SOURCE` | `input` | `input` watches businesses with an authorised or active loan; `json` reads `MONITOR_LOCATIONS_FILE` |
| `MONITOR_LOCATIONS_FILE` | `data/monitor-locations.json` | Watched locations when `MONITOR_LOCATION_SOURCE=json`, and for `monitor:simulate` |
| `MONITOR_ALERT_SINK` | `outbox` | `console` prints alerts instead of queueing them |

It reaches the other units through small interfaces in `monitor/ports.ts`. The list of watched locations comes from the input service's tables (`adapters/inputLocationSource.ts`) or the JSON file. The logs system is not built, so it is the console for now; the monitor README gives the steps to swap it in.

## Code map (`api/`)

```
api/
├── prisma/schema.prisma          Database schema
├── prisma/migrations/            Eight migrations: climate_tool, idempotency_keys, alerts, climate_monitor, input_service, auth, finance_service, audit_events
├── data/monitor-locations.json   Locations for monitor:simulate, or the monitor with MONITOR_LOCATION_SOURCE=json
├── prisma.config.ts              Prisma 7 config; the datasource URL lives here
├── vitest.config.ts              Points tests at a *_test database and Redis database 1; test files run one at a time
├── vitest.global-setup.ts        Applies migrations to the test database
└── src/
    ├── server.ts                 Entry point: connects, wires dependencies, listens
    ├── app.ts                    createApp(deps): security headers, audit trail, rate limits, CORS, sessions, idempotency, routes
    ├── config/
    │   ├── env.ts                Validated environment variables
    │   ├── db.ts                 Prisma client, connectDb, disconnectDb
    │   ├── redis.ts              Redis client that fails fast when Redis is down
    │   └── climate.ts            Every tunable number in the pipeline and the agent
    ├── errors/app-error.ts       AppError and its 400/401/403/404/409 subclasses
    ├── middleware/
    │   ├── error-handler.ts      404 handler and the single error formatter
    │   ├── rate-limit.ts         rateLimiter(limit): per-client, one minute window
    │   ├── cors.ts               CORS for the allowed frontends, and the Origin check on writes
    │   ├── security-headers.ts   No caching, framing or type sniffing on any answer; HSTS when the cookie is Secure
    │   ├── audit.ts              auditTrail: the request id and one audit event per write or refusal; auditNote names the record
    │   ├── auth.ts               loadSession, requireAuth, requireBank: who is calling and who may
    │   └── idempotency.ts        Idempotency-Key handling and the in-memory store
    ├── routes/                   health.ts, auth.ts, climate.ts, alerts.ts, finance.ts
    ├── controllers/              auth, climate, alerts and finance controllers: parse input, call the service
    ├── jobs/climate-refresh.ts   Six-hourly forecast refresh of every known location
    ├── prompts/                  Every prompt sent to a model
    │   ├── climate.ts            The climate agent's two system prompts
    │   ├── advisor.ts            The chat advisor's system prompt, per mode
    │   └── classifier.ts         The weather-impact classifier's system prompt, examples and messages
    ├── generated/prisma/         Generated client. Gitignored; never edit
    └── services/
        ├── cache/cache.ts        Cache interface, Redis implementation, no-op cache
        ├── idempotency/prisma-store.ts   Postgres store for idempotency keys
        ├── auth/
        │   ├── config.ts         Session lifetime, cookie name, and the GOOGLE_CLIENT_ID and AUTH_* settings
        │   ├── google.ts         Verifies a Google ID token
        │   ├── service.ts        Sign-in, session lookup, sign-out, roles
        │   └── testing/fake-auth.ts   Stand-ins for the auth service and for Google
        ├── finance/              The finance service; see its README.md
        │   ├── service.ts            The pipeline and the four tool-ready functions
        │   ├── config.ts             FINANCE: every weight, band, cap and limit; FINANCE_* settings
        │   ├── metrics/compute.ts    Financial ratios and the amortisation formula
        │   ├── scoring/              baseline, scorer (rules and the ML stub), sensitivity, stress, adjusted
        │   ├── profile/              Output schema; assembling and validating the profile
        │   ├── store.ts              finance_profiles and finance_request_log
        │   └── testing/fixtures.ts   Sample inputs and a stand-in climate unit
        ├── evaluator/            The evaluator; see "The evaluator"
        │   ├── service.ts            evaluate() and history()
        │   ├── checks.ts             The twelve checks
        │   ├── rating.ts             Combined rating and reasons
        │   ├── config.ts             EVALUATOR: version, freshness limits, rating table
        │   ├── schema.ts             Strict output schema
        │   └── store.ts              evaluations
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
- **A finance weight, score band, stress cap or penalty**: `FINANCE` in `src/services/finance/config.ts`, then bump `FINANCE.modelVersion`.
- **A rate limit**: `rateLimit`, `climateRateLimit`, `advisorRateLimit` and `advisorAnswerRateLimit` in `createApp`'s arguments; the defaults are in `app.ts`.
- **A new endpoint**: add a handler in a controller and register it in `routes/`. Throw an `AppError`; do not format error responses by hand. It inherits the global rate limit and idempotency; add a stricter limit in `app.ts` if a request is expensive.
- **A database column**: edit `schema.prisma`, then run `npm run db:migrate`.

## Database

Twenty-three tables are described here, all defined in `api/prisma/schema.prisma`. The input service's tables are described in `api/src/services/input/README.md`.

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
| `users` | One row per Google account that has signed in: Google's account id, email, name, picture. No role column; see [Authentication](#authentication) |
| `sessions` | One row per signed-in browser: the hash of the session token, the user and the expiry |
| `monitored_cells` | One row per watched forecast cell: level, calm count, next check time, the last check's snapshot, and the lease of the monitor checking it |
| `disaster_events` | One row per sudden change the monitor detected, with the forecast values, and later the observed values and a `hit`, `false_alarm` or `missed` label |
| `finance_profiles` | Every finance profile generated, append only: the response, the raw inputs behind it, the snapshot version, both scores, the scorer and the model version |
| `evaluations` | Every evaluation, append only: the response, the rating, whether it was reliable, the finance profile and the climate forecast run it was built from, and who asked |
| `audit_events` | The security audit trail, append only: who (user id and role) did what (method and route) to which record, the outcome and the request id. See [Authentication](#authentication) |
| `finance_request_log` | One row per finance call: request id, operation, business, outcome, sources, fallbacks used and milliseconds per stage |

A cached response is identified by cell, API name and a hash of the requested variables. Observed and projection metrics use the Unix epoch as `issued_at`, so refetching history never duplicates a day.

## Testing

```bash
cd api
npm test
```

- Tests run against a separate database. `vitest.config.ts` appends `_test` to the database name in `DATABASE_URL`, and the global setup applies migrations to it and refuses to run against a database whose name does not end in `_test`. Postgres must be running.
- Redis is separated the same way: tests use logical database 1 and development uses 0. Only `src/services/cache/cache.test.ts` talks to the real Redis, so Redis must be running too. Other tests use the in-memory cache in `testing/memory-cache.ts`.
- Tests never call Open-Meteo. `fakeOpenMeteo` generates synthetic history and forecasts, records which APIs were called, and can simulate outages through its `failing` option.
- Tests never call Google. Route tests that are not about signing in pass `fakeAuth()` from `src/services/auth/testing/fake-auth.ts` to `createApp` and send requests with `signedIn(app, user)`. `src/routes/auth.test.ts` runs the real auth service against Postgres with `fakeGoogle` in place of the token check.
- Tests never call OpenAI. `testing/fake-agent.ts` stands in for the agent in pipeline tests, and `agent.test.ts` passes a stub client to `createOpenAiAgent`.
- `src/services/alerts/worker.test.ts` runs the alert worker against real Postgres with a fake email provider and a controllable clock. Tests never call SMTP.
- The route tests in `src/routes/climate.test.ts` are integration tests: the real Express app and real Postgres, with a controllable clock. They truncate all climate tables before each test.
- The monitor's tests are in `src/services/climate/monitor/`. The rules, cadence, cells and labelling are pure and need no database. `tick.test.ts` and `verifyJob.test.ts` use real Postgres with the climate pipeline stubbed, and `integration.test.ts` runs the monitor on the real pipeline with `fakeOpenMeteo`.
- The finance service's unit tests are in `src/services/finance/` and need no database. `src/routes/finance.test.ts` runs every finance route against real Postgres and the real input service, with a stand-in climate unit (`finance/testing/fixtures.ts`) and, in one test, the real climate pipeline on `fakeOpenMeteo`.
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
- **A new route is open unless you guard it.** `loadSession` only works out who is calling. Mount the route with `requireAuth` or `requireBank` in `createApp`, as `/climate` and `/alerts` are.
- **The session cookie is `SameSite=Lax` by default.** That works when the frontend and the API are on the same site, such as two ports on `localhost`. If they are deployed on different sites, set `AUTH_COOKIE_SAMESITE=none` and serve both over HTTPS, or the browser will not send the cookie.
- **Removing someone from `AUTH_BANK_EMAILS` needs a restart.** The lists are read once at startup. Their open sessions lose the bank role from then on.
- **Rate limiting is by IP address, counted in process memory, and `trust proxy` is not set.** Behind a reverse proxy, every client would share one limit; with several instances, each would count separately.
- **The `stale` value of `climate_responses.status` is unused.** Nothing writes it since stale data stopped being served. Expired screening rows stay in Postgres until the next re-screening overwrites them, and nothing reads them.
- **Prisma 7.** The client is generated into `src/generated/prisma` and uses the `@prisma/adapter-pg` driver adapter. The database URL is in `prisma.config.ts`, not in `schema.prisma`.
- **Run `npm run db:generate` after pulling a migration.** `prisma migrate dev` applied the alerts migration without regenerating the client, and every `prisma.alert*` call then fails to typecheck.
- **Alert content files are not copied to `dist/`.** `tsc` leaves `guidelines.json` and `templates/` behind, so a compiled worker reads them from `src/`. Ship `src/services/alerts/` content with any deployment.
- **Replying STOP does not update the database.** Emails tell people to reply STOP, but nothing reads replies. Set `alert_contacts.opted_out_at` by hand until an inbound webhook exists.
- **A bank digest covers at most 20 alerts.** The worker claims 20 rows per batch; more `WATCH` alerts than that go out as a second digest email.
- **Never commit `.env` files or `src/generated/`.** Both are gitignored.

## Not built yet

- A production frontend. `web/` is a static console for showing and testing the API, not the product UI. It has no tests.
- Using the ML models inside the pipeline. The UI can call them through `/ml`, but the monitor does not ask for an alert's calibrated probability, and the finance score ignores the cash-flow simulation. The web console has no `/ml` panel yet. The finance service scores with rules; its ML scorer is a stub that would call a model over HTTP (`FINANCE_SCORER=ml`), and no model exists.
- The advisor's use of the finance service's other functions. It sees the finance service only through the evaluation; the scenario, location and repayment-capacity functions are not tools yet, and the advisor still runs its own cash-flow and repayment maths on the business's own figures.
- A way to manage users. Bank officers are named in `api/.env`; there is no admin screen, and no way to hand a business to a different owner except by editing `businesses.owner_user_id`.
- `request_log.requester_id` for signed-in users. It is still null for every client request; only the monitor sets it.
- The World Bank flood exposure raster. `createClimateService` accepts an `exposure` provider, but none is passed, so every response carries a `flood_exposure_unavailable` warning and confidence is `med` at best.
- Evidence for agent decisions. The agent works from its own knowledge with no search or retrieval, so the `evidence_urls` column is always empty.
- The logs system. The monitor logs to the console, behind the `RunLogger` interface.
- A schedule for `npm run monitor:verify`. It runs once and exits; nothing runs it daily yet.
- Alerts when a hazard score rises a band. `job.md` section 3 lists that trigger; the monitor acts on forecast thresholds and dormant tripwires only.
- A way to manage alert contacts. Owners of input-service businesses are reached through their own contacts and consent; bank contacts and opt-outs are still rows written by hand or by `npm run alerts:test -- --seed`. Consent cannot be changed after a business is created: `PATCH /businesses/:id` does not accept it.
- SMS alerts. Removed for now; see `RESOLVE_LATER.md` item 5.
- Native-speaker review of the Hindi and Marathi alert texts.
- A job queue. The forecast refresh runs on a timer inside the API process; Redis is configured for BullMQ, but BullMQ is not installed.
- Handling of Open-Meteo's rate limits: waiting out a 429, queueing heavy calls, or pre-warming the demo cities.
- Shared state for several API instances: the cell lock, the refresh job and the rate limit counters are all per process. The same goes for the cell lock between the API and the monitor.
- `severe` events for anything other than river flood, which would need ensemble forecasts.
- Dockerfiles, CI and deployment.
- CORS. A browser on another origin cannot call the API yet.

The thresholds and weights are starting assumptions and have not been tuned against real outcomes.
