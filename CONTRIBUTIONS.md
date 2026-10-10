# Contributions

Who did what on this project. There are three of us, and each person owned one area.

| Person | Area | Main folders |
| --- | --- | --- |
| Tushar Nebhnani | Backend | `api/`, `landing/`, `web/` (API wiring) |
| Adarsh Hulawale | Security | `Security/`, `api/src/middleware/` |
| Janhvi Deshmukh | UI/UX, datasets, features and EDA | `web/` (design), `ml/data/`, `ml/features/`, `ml/eda/` |

---

## Tushar Nebhnani: Backend

Tushar designed and built the API and the services behind it.

- **Project setup.** Express 5, TypeScript and Prisma 7 API, with Postgres and Redis through Docker Compose.
- **Climate risk pipeline.** Open-Meteo history and projections, hazard scoring, caching, and the optional OpenAI climate agent.
- **Background monitor.** Watches registered locations, sorts rain into classes, runs a verification job, and queues alerts.
- **Email alert system.** An outbox, a worker, templates and preventive steps, with consent and cooldown checks.
- **Sign-in and roles.** Sign in with Google, sessions, the business and bank-officer roles, and auth-protected routes.
- **Finance service.** Baseline and climate-adjusted scores with an uplift cap.
- **Evaluator service.** Checks the climate and finance answers together and rates them for the chat advisor.
- **Input service.** Still being built.
- **ML endpoints.** Storm calibration, cash-flow simulation, models 5 and 6, and the `/ml` routes the API calls.
- **Shared limits.** Rate limiting, `Idempotency-Key` support, app logs, and the per-user answer limit and guardrails on the advisor.
- **Frontends.** The React landing page and the API wiring for the web console demo.
- **Docs.** `README.md` and `AGENTS.md`.

## Adarsh Hulawale: Security

Adarsh owned how the system is protected and how that protection is checked.

- **Security documents** in `Security/`: a threat model, a security checklist, the audit logging design, and a test guide.
- **HTTP hardening.** Security headers (`security-headers.ts`), a strict CORS policy (`cors.ts`), and safer error responses that do not leak internal detail.
- **Security audit middleware** (`security-audit.ts`), which records refused and suspicious requests.
- **Access control.** Restricted the advisor's development routes, and limited bank decisions to businesses the bank is allowed to see.
- **Access matrix tests** (`routes/access-matrix.test.ts`), which check every route against every role.
- **Clean-up.** Removed the unused `/demo` route, and brought the security fixes from `main` together with his branch.

## Janhvi Deshmukh: UI/UX, datasets, features and EDA

Janhvi owned how the product looks and the data that the models learn from.

- **UI/UX.** Layout, flow and visual design of the web console and its Analysis page.
- **Dataset collection.**
  - Weather history (`fetch_weather.py`, `weather_dataset.csv`).
  - NASA POWER climate data (`fetch_power.py`).
  - GEOGLOWS river flow data (`fetch_geoglows.py`).
  - IBTrACS cyclone tracks for the North Indian Ocean (`data/external/ibtracs/`).
  - Flood and storm event records (`events_flood.csv`, `events_storm.csv`), monitored locations and hazard parameters.
  - Recorded data assumptions in `ml/data/ASSUMPTIONS.md`.
- **Feature engineering** in `ml/features/`: the location and month spine, event tables, monthly aggregates, anomaly features, and the feature tables for alert calibration (`features_flood.csv`, `features_storm.csv`).
- **Exploratory data analysis** in `ml/eda/`: flood rainfall percentiles, floods per year, and reliability plots for the flood and storm alerts (`ml/eda/figures/`).
- **Also built** the first version of the chat advisor (`api/src/services/advisor/`), including its tools, prompts and tests.

---

*Taken from the git history up to 10 October 2026. If something is missing or credited to the wrong person, edit this file directly.*
