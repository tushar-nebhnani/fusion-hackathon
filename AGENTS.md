# Working in this repository

Instructions for any AI coding agent working here. `README.md` is the reference: what exists, how the pipeline works, every endpoint, table and setting. This file is shorter and says how to work: what to run, what to leave alone, and what counts as done. Where the two disagree, the code decides; fix whichever document is wrong.

## What is here

| Folder | What it is | Work on it? |
| --- | --- | --- |
| `api/` | Express 5 + TypeScript + Prisma 7 API. All the real work | Yes |
| `api/src/services/climate/` | The climate risk pipeline and its optional OpenAI agent | Yes |
| `api/src/services/climate/monitor/` | The background monitor. Has its own `README.md` | Yes |
| `api/src/services/alerts/` | The email alert system. Design in `job.md` | Yes |
| `api/src/services/auth/` | Sign in with Google, sessions and roles | Yes |
| `api/src/services/finance/` | The finance service: baseline and climate-adjusted scores. Has its own `README.md` | Yes |
| `api/src/services/evaluator/` | Checks the climate and finance answers together and rates them; the chat advisor's only way to both. Described in `README.md` | Yes |
| `api/src/services/input/` | The input service, still being built | Only when asked. It is not documented here or in `README.md` yet |
| `landing/` | Product landing page plus the Playground (`/playground`) and Analysis (`/analysis`) pages: Vite + React + TypeScript, light theme only. Landing copy in `src/content.ts`; the pages in `src/pages/`, their API client, session and example data in `src/shared/` (named so the root `.gitignore`'s `lib/` rule does not hide it). `src/shared/samples.ts` holds the example data. Check with `npm run build` inside `landing/` | Yes |
| `ml/` | Python ML service: data, features, training, saved models, a FastAPI app and `pytest` tests. The API reaches it through `/ml` (`api/src/services/ml/`). Commands are in `ml/data/README.md` | Yes |

Four processes exist, each started by hand inside `api/`: the API (`npm run dev`), the alert worker (`npm run alerts:worker`), the monitor (`npm run monitor`) and the verification job (`npm run monitor:verify`). None starts another.

## Set up

Requirements: Node 24, Docker, npm.

```bash
docker compose up -d            # Postgres 16 and Redis 7, from the repository root
cd api
cp .env.example .env            # only if api/.env does not exist
npm install
npm run db:migrate              # applies migrations and generates the Prisma client
```

Every `npm` command below runs inside `api/`.

## Check your work

```bash
npm run typecheck
npm run lint
npm test
```

All three must pass before you say a task is done. If one fails, say so and show the output.

- `npm test` needs Postgres and Redis running. It uses its own database (`<name>_test`) and Redis database 1, so it never touches development data.
- The full run takes a few minutes. To run one file: `npx vitest run src/services/climate/scoring.test.ts`.
- Test files run one after another because they empty the same tables. Do not turn `fileParallelism` back on.
- For the same reason, only one test run can use the test database at a time. If another agent or terminal is running `vitest`, the climate and monitor suites fail with wrong row counts and cache results. Check with `pgrep -fl vitest`, wait, and run again before treating such a failure as real.
- Tests never call Open-Meteo, OpenAI, Google or SMTP. Use the fakes in `src/services/climate/testing/`, `src/services/climate/monitor/testing/` and `src/services/auth/testing/`; do not add a test that reaches the network.
- Tests sit next to the code as `*.test.ts`.

## Rules

- **Show a major change to existing code before making it.** If a fix or update rewrites behaviour that already works, describe the change and wait for the owner's approval. New files and small, local fixes do not need this.
- **Every endpoint is rate limited and honours `Idempotency-Key`.** Both are mounted once in `createApp` (`src/app.ts`). Mount new routes below them, and add a stricter limit there if a request is expensive.
- **Every endpoint needs a signed-in user unless it is meant to be public.** Mount new routes with `requireAuth` or `requireBank` from `src/middleware/auth.ts`; without one a route is open. Only `/health` and `/auth` are public.
- **Every write and every refusal is audited.** `auditTrail` in `src/middleware/audit.ts` records them for all routes. In a new handler, call `auditNote(res, { target })` to name the record it changes. Never put a request body, token or financial value in an event, and never update or delete `audit_events`.
- **Do not commit or push unless asked.** Never commit `.env` files or `src/generated/`.
- **Do not read out or copy secrets** from `api/.env`. `api/.env.example` lists every variable.
- **Keep `README.md` true.** When you change a threshold, endpoint, table, setting or command, update the README in the same piece of work. It is the handover document.
- **Do not weaken a safety limit to make something pass**: the agent's raise-only rule, the finance score's uplift cap, the alert consent and cooldown checks, the test database name check, the strict response schema, the loan lock on an owner's changes, or the sign-in, ownership, sharing-consent and `Origin` checks.

## Sharing `main`

Several people and their agents commit to `main`. Most past conflicts were in `README.md` and `api/src/app.ts`.

- **Start from the latest `main`.** Run `git pull --rebase --autostash` before you begin and again before you commit.
- **Rebase unpushed commits; do not merge `origin/main` into `main`.** A merge commit is only for work that is already pushed.
- **Touch only the lines your change needs in the shared files above.** Do not reorder, reformat or rewrap them. Add a table row or a route mount next to the related ones, not at the end of the file.
- **Keep work small and hand it back soon.** Work that sits unpushed for hours is what conflicts. Use a branch and a pull request for anything larger than a few files.
- **If a rebase conflicts, keep both sides' intent** and run the checks again. Never resolve by discarding the other person's change.

## Commands that reach outside this machine

Run the safe one unless the task needs the real one.

| Real | What it does | Safe way to look |
| --- | --- | --- |
| `npm run monitor` | Calls Open-Meteo and queues alerts in the real outbox | `npm run monitor:simulate -- --location L1 --scenario heavy-rain`, or `MONITOR_ALERT_SINK=console` |
| `npm run alerts:worker` with `ALERTS_MODE=live` | Sends email through SMTP | Leave `ALERTS_MODE=dry_run`, the default |
| A first `POST /climate/profile` for a new place | Downloads about 30 years of history; one such call uses most of Open-Meteo's free per-minute allowance | Reuse a place already screened, or wait a minute between new places |
| Any request with `OPENAI_API_KEY` set | Calls OpenAI and costs money | Leave the key blank; results are then rule-based |

Do not change `ALERTS_MODE`, `MONITOR_ALERT_SINK` or the OpenAI key in `api/.env` without being asked.

## Code conventions

- **ES modules with NodeNext.** Relative imports end in `.js`, although the files are `.ts`.
- **Strict TypeScript** with `noUncheckedIndexedAccess`: indexing an array gives `T | undefined`.
- **Dependencies are passed in, not imported.** `createApp(deps)`, `createClimateService(deps)` and the monitor's `container.ts` take the database, clients, cache, agent, clock and logger as arguments. This is what makes the tests possible.
- **Errors are thrown as `AppError`** (`src/errors/app-error.ts`) and formatted in one place, `middleware/error-handler.ts`. Do not build an error response by hand. Express 5 passes a rejected promise to the handler without a wrapper.
- **Latitude comes first**, in arguments, cell ids and upstream requests.
- **Names:** snake_case in API responses and database columns (through Prisma `@map`), camelCase in TypeScript. Unused arguments start with `_`.
- **Dates and timestamps are in IST** (`Asia/Kolkata`).
- **Tunable numbers live in `src/config/climate.ts`**, or `LIMITS` and `HAZARD_CATALOG` in `hazards.ts`. Do not put a threshold in the middle of a function.
- **Settings that must not stop the API** (`ALERTS_*`, `SMTP_*`, `MONITOR_*`, `INPUT_*`, `FINANCE_*`, `ML_*`) are read by their own `config.ts` and fall back to defaults. Only `src/config/env.ts` may exit the process.
- **Comments are short** and say why, not what. Write code that reads like the code around it.

## Where to make a change

| To change | Edit |
| --- | --- |
| A threshold, weight, cache lifetime or grid size | `src/config/climate.ts`, or `LIMITS` / `HAZARD_CATALOG` in `services/climate/hazards.ts` |
| A monitor interval, rain class or timeout | The `monitor` section of `src/config/climate.ts` |
| A finance weight, score band, stress cap or penalty | `FINANCE` in `src/services/finance/config.ts`, then bump `FINANCE.modelVersion` |
| The finance profile's shape | `services/finance/profile/schema.ts`, then `buildProfile` in `profile/build.ts`. The schema is strict |
| The profile response shape | `services/climate/schema.ts`, then the object built at the end of `run()` in `profile.service.ts`. The schema is strict: an extra key fails with `INVALID_OUTPUT` |
| What the climate agent is told | `src/prompts/climate.ts`, then bump `CLIMATE.agent.promptVersion` |
| What the chat advisor is told | `src/prompts/advisor.ts`, then bump `PROMPT_VERSION` in the same file |
| What the weather-impact classifier is told | `src/prompts/classifier.ts`, then bump `INPUT.classifier.promptVersion` |
| An endpoint | A handler in `src/controllers/`, registered in `src/routes/`, mounted in `src/app.ts` with `requireAuth` or `requireBank` |
| Who is a bank officer | `AUTH_BANK_EMAILS` and `AUTH_BANK_DOMAINS` in `api/.env` |
| Session lifetime or the cookie name | `AUTH` in `src/services/auth/config.ts` |
| A database column | `prisma/schema.prisma`, then `npm run db:migrate`. Never edit an applied migration |
| Alert wording or preventive steps | `services/alerts/templates/` and `guidelines.json`. No code change needed |
| Who the monitor watches | `api/data/monitor-locations.json`, or a new `WatchedLocationSource` adapter wired in `monitor/container.ts` |

## Traps

`README.md` has the full list under "Things that will catch you out". The ones that most often cost time:

- **Run `npm run db:generate` after pulling or writing a migration** if Prisma types look wrong. A stale client makes every new model fail to typecheck.
- **Fetch the Open-Meteo archive before the climate projections, never at the same time.** They share one per-minute limit. A test protects this order.
- **A 503 on a first lookup is usually Open-Meteo's rate limit**, not a bug you introduced. Wait a minute and retry before changing code.
- **Comments mention "README section 12", "section 17", "Call 6" and "Call 7".** They point to a specification that was never committed, not to `README.md`.
- **The per-cell lock, the refresh job and the rate limit counters are per process.** Do not write code that assumes the API and the monitor share them.
- **The monitor and the alert system are two units.** The monitor only calls `enqueue()`; it never sends. The alert worker only reads the outbox; it never decides what is dangerous.

## Before you say it is done

1. `npm run typecheck`, `npm run lint` and `npm test` pass, or you have said which one fails and why.
2. New behaviour has a test next to the code.
3. `README.md` still describes what the code does.
4. You have said what you did not do or could not verify.
