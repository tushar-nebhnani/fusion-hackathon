# Advisor: notes, assumptions and stubs

Written 2026-10-09 while building the unit from the advisor job spec (README §0 step 5).

## How to run

```bash
docker compose up -d postgres redis          # from the repo root
cd api && npx prisma migrate deploy && npm run dev
curl -X POST localhost:4000/advisor/chat -H 'content-type: application/json' \
  -d '{"businessId":"SME-0101","loanId":"LN-0101","message":"Should I take a ₹3L loan?"}'
```

With no API key the advisor runs the **offline planner** (`llm/offline.ts`): a deterministic
stand-in that drives the same tool loop and writes template answers from tool results. Set
`ADVISOR_LLM_API_KEY` (or the existing `OPENAI_API_KEY`) to use the model.

## Stubs (replace when the real units exist)

| Stub | Where | Replace with |
|---|---|---|
| Finance unit | `tools/finance.ts` reads `api/data/smes.json` | the finance unit's public function |
| Input service / business data | `directory.ts` loads `api/data/smes.json` (4 synthetic businesses, loans `LN-0101`, `LN-0142`, `LN-0203`, `LN-0307`) | the business table and the input service |
| Weather-impact classifier | `tools/weatherImpact.ts` reads `weatherImpact` from the business profile; missing → `{ effect: "unknown" }` | the classifier's output |
| Background monitor | `dev/fakeAlert.ts` + `POST /advisor/dev/fake-alert`; `handleAlert` and `handleVerification` are internal functions for it | `BACKGROUND_JOB.md` |
| SMS | No SMS sender exists (removed from the alert system, `RESOLVE_LATER.md` item 5). SMS text is composed (≤160 chars), stored and logged with status `unavailable`. | add an SMS sender in `alerts/senders/` and route `channel: "sms"` to it in `tools/messaging.ts` |
| Hazard seasonality | `tools/climate.ts` `hazardSeasons()`: a static India-wide table (one rule for the south-east coast's NE monsoon). The climate profile has no months. | seasonality from the climate unit |

## Deviations from the spec, and why

- **TypeScript, not `.js`.** The API is TypeScript (ESM, Prisma, Vitest), so every file is `.ts`.
- **Prompts are TS strings** in `prompts/index.ts`, not `.md` files. `tsc` does not copy `.md` to
  `dist/`, and the repo already keeps prompts as TS (`src/prompts/climate.ts`).
- **Routes** live in `src/routes/advisor.ts` + `src/controllers/advisor.controller.ts`, like the
  other units. Mounted in `app.ts` only when an advisor is passed.
- **Tools take no `businessId` / `lat, lon` from the model.** The business and loan come from the
  request context, so a tool call cannot read another business's data.
- **`generateRepaymentOptions` takes no `cashflow` argument.** It recomputes the cash flow from
  the stored damage, so the model never passes (or alters) a 12-month array.
- **Extra tools:** `getHazardSeasons`, `getDamageReport`, `saveDamageDetails` (damage intake by chat).
- **Extra endpoints:** `GET /advisor/businesses`, `POST /advisor/loans/:loanId/disburse`
  (PRE_LOAN→ACTIVE) and `POST /advisor/loans/:loanId/close-recovery` (RECOVERY→ACTIVE); the
  state machine needs a bank action for both. Dev only: `/advisor/dev/verify-alert`,
  `/advisor/dev/sweep-alerts`.
- **Extra table:** `advisor_alert_events` (the "alert event store" `getAlertContext` reads).
  `loan_states` also has `damage` and `alert_id` columns.
- **Alert event shape:** as in §5, with `severity` one of `watch | warning | severe` and ISO
  datetimes. Monitor hazard names are mapped (`heavy_rain` → `flash_flood`, `cyclone` → `storm`, …)
  in `types.ts` `hazardFromAlert()`.

## Calculation assumptions

- Net operating income = revenue × (1 − variableCostShare) − fixed costs. A lost sale also saves
  its cost of goods, so revenue loss reduces income by `revenueLoss × (1 − variableCostShare)`.
- Unknown weather impact → sensitivity 1.0 (full loss on closure days), labelled
  `assumed_full_loss_unknown_impact`, and the answer says the impact is unknown.
- In recovery, closed days lose 100% of sales (a closed shop sells nothing); stock + equipment
  loss is paid in the reopening month (restock/repair); an insurance payout arrives in its month.
- Outstanding balance assumes every EMI to date was paid on time. A loan with no `disbursedOn`
  is treated as just disbursed.
- DSCR with negative income is reported as 0, not a negative ratio (a negative ratio would make a
  smaller payment look worse). Options also report `cashShortfall`; when no option keeps DSCR ≥
  1.2, the recommendation is the smallest shortfall.
- Moratorium length = months at the start of the projection where income < EMI + other debt,
  between 1 and 6. Tenure extension = 12 months. Step-down = half EMI for the same months.
  Insurance bridge prepays 50% of the payout (`BRIDGE_PREPAY_SHARE`); the rest is for restocking.

## Guards (README §1, §8)

- **Numbers:** every number in the answer text must match a tool result, tool input, the owner's
  words or a stored fact (within display rounding). Otherwise one repair pass; if still wrong, the
  answer stands with `warnings`. Small counts (≤12), years, dates, times and ids are not checked.
- **Citations:** must name a successful `call_n` in the conversation and, if given, a field path
  that exists in its output. Invalid ones are dropped after the repair pass.
- **Verdict floor:** the model may make a verdict stricter than the scenario DSCRs imply, never
  more lenient (`checks.ts` `verdictFloor`).
- **Alerts only add urgency:** dismissive wording gets one repair pass, then the answer is
  replaced. Fewer than 3 actions are topped up from the alert system's `guidelines.json` steps.
- **No approval:** the agent only creates a `pending_bank` proposal; only
  `POST /advisor/proposals/:id/decision` with `accept` moves a loan to RECOVERY.

## Known gaps

- **Open-Meteo rate limit:** a first lookup for a new location can 503 (`RESOLVE_LATER.md` item 1).
  The advisor then says climate data is unavailable and gives no verdict. Before a demo, warm the
  demo cities with `POST /climate/profile`, one a minute.
- No auth on any endpoint (none exists in the API yet). The bank decision endpoint needs it
  before real use.
- The offline planner parses owner answers with keyword rules; it is for demos, not real chat.
- Tested with the offline planner and scripted model replies; not yet run against a real key.
