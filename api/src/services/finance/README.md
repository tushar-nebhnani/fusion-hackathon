# Kshetra — Finance Service

Takes a business that was entered through the form and produces its **finance profile**: a baseline financial health score, and a **climate-adjusted** score that stress-tests the business against the hazards the climate unit reports for its location.

- **Rules decide, the LLM only informs.** The only model output this service reads is the weather-impact profile the input service's classifier stores. It is an input to the stress test. No model decides approval or overrides a computed metric.
- **Every number is traceable.** A profile names the snapshot, loans and impact-profile version it was computed from, and the raw inputs are stored with it.
- **The climate unit is called, never changed.** One call to its entry function, `getProfile(point)`; its output is read only.

## 1. Status

Built and tested. The routes in §9 are mounted in the API, and the service is connected to the input service's two finance triggers (§9).

It does **not** contain a form API or a classifier of its own. Both already exist in the input service (`api/src/services/input/`), which is where a business, its financials, its loans and its weather-impact profile are entered and stored. This service reads them through `InputService.getBusiness(id)` and writes nothing back. §13 lists how that differs from the original job brief.

```
cd api
npm run db:migrate        # applies 20261009123252_finance_service (2 new tables)
npm run dev               # routes are live on http://localhost:4000/finance
npm test
```

---

## 2. Flow

Entry function: `getFinanceProfile(businessId, options)` in `service.ts`.

```
 load business        input service: scoring snapshot (newest verified), loans, impact profile
     │                no snapshot ──▶ 409 NO_FINANCIALS
     ▼
 compute metrics      §3
     │
     ▼
 baseline score       §4, through the scorer (§7)
     │
     ▼
 climate profile      climate unit's entry function, read only
     │                fails ──▶ baseline only, adjusted: null, a warning (§10)
     ▼
 stress test          §5, one result per hazard
     │
     ▼
 adjusted score       §5, with drivers
     │
     ▼
 build profile ─▶ output validation ─▶ store ─▶ log request
```

### Where each input comes from

| Finance input | Read from |
|---|---|
| Monthly revenue (6–12 months) | `scoring_snapshot.raw.monthly_revenue`: the newest snapshot the bank verified, or the newest while none is |
| Monthly expenses | `scoring_snapshot.raw.monthly_opex` (one average, excluding repayments) |
| Existing EMI, outstanding debt, cash, missed payments | `existing_emi_total`, `outstanding_debt`, `cash_balance`, `payment_delays_12m` of the snapshot |
| Requested loan | Loans in status `applied` or `authorised`: their `emi` and `amount`. An `active` loan is already inside the owner's `existing_emi_total` |
| Business age | Current year (India time) − `profile.year_started` |
| Location | `locations.primary` |
| Insurance | `operations.insurance_covers`, when `has_insurance` |
| Weather sensitivity | The current weather-impact profile (`impact_profile.conditions`) |

The metrics are computed here from the raw values, not taken from the snapshot's `derived` block, so a loan applied for after the snapshot was saved is counted.

---

## 3. Metrics

`metrics/compute.ts`. All amounts are INR per month unless stated.

| Metric | Definition |
|---|---|
| `avg_monthly_revenue` | Mean of the months given |
| `avg_monthly_expenses` | The entered monthly operating cost |
| `net_monthly_cashflow` | Revenue − expenses, before repayments |
| `existing_emi`, `proposed_emi`, `total_emi` | Current repayments, the requested loans' EMI, and their sum |
| `dscr` | `net_monthly_cashflow / total_emi`; `null` when there is no debt |
| `surplus_after_debt` | `net_monthly_cashflow − total_emi` |
| `cash_runway`, `cash_runway_months` | `burning` and `cash / max(−surplus, 1)` when the surplus is negative; otherwise `positive_cashflow` and `null` |
| `cash_buffer_months` | `cash / (expenses + total_emi)`; `null` when both are zero |
| `revenue_volatility` | Coefficient of variation of monthly revenue (population standard deviation, as the input service derives it) |
| `seasonality_index` | Best month ÷ average month |
| `leverage` | (Outstanding debt + requested principal) ÷ (average revenue × 12) |
| `repayment_record` | `missed_payments_12m` and a rating: 0 `clean`, 1 `minor`, 2–3 `watch`, more `poor` |
| `years_in_operation`, `months_of_history` | |

`amortisedEmi(principal, annualRatePct, months)` is the standard formula `P·r·(1+r)ⁿ / ((1+r)ⁿ − 1)` with `r` the monthly rate. It is used for a loan request that names no EMI (`evaluateLocation`); a stored loan uses the EMI the bank entered.

---

## 4. Baseline score

`scoring/baseline.ts`. A score from 0 to 100, higher is healthier: six banded sub-scores, weighted. **All weights and bands are in one object, `FINANCE.baseline` in `config.ts`**; tune them there and bump `FINANCE.modelVersion`.

| Sub-score | Weight | Bands (value → sub-score) |
|---|---|---|
| `dscr` | 0.30 | ≥ 2 → 100 · ≥ 1.5 → 85 · ≥ 1.25 → 70 · ≥ 1 → 45 · ≥ 0.75 → 20 · below → 0. No debt → 100 |
| `runway` | 0.20 | Burning cash, by months left: ≥ 12 → 70 · ≥ 6 → 50 · ≥ 3 → 30 · ≥ 1 → 10 · below → 0. Not burning, by `cash_buffer_months`: ≥ 3 → 100 · ≥ 1 → 85 · below → 70 |
| `leverage` | 0.15 | ≤ 0.1 → 100 · ≤ 0.25 → 85 · ≤ 0.5 → 65 · ≤ 1 → 35 · ≤ 2 → 15 · above → 0 |
| `volatility` | 0.10 | ≤ 0.1 → 100 · ≤ 0.2 → 80 · ≤ 0.35 → 60 · ≤ 0.5 → 35 · above → 10 |
| `repayment` | 0.15 | Missed payments: 0 → 100 · 1 → 75 · 2 → 50 · ≤ 4 → 25 · more → 0 |
| `business_age` | 0.10 | Years: ≥ 10 → 100 · ≥ 5 → 80 · ≥ 3 → 60 · ≥ 1 → 35 · below → 15 |

Risk bands: `low_risk` ≥ 70 · `moderate` 50–69 · `high` 30–49 · `critical` < 30.

The result is `{ score, band, sub_scores, source }`. These numbers are starting assumptions and have not been calibrated against outcomes.

---

## 5. Stress test and adjusted score

### 5.1 Sensitivity (`scoring/sensitivity.ts`)

The input service's classifier stores two values per hazard: `physical` (0 to 1, how much of the business stops) and `demand` (−1 to +1, how customer demand moves). This service restates them as one revenue effect:

```
effect    = (1 − physical) × (1 + demand) − 1
direction = unfavourable if effect < −0.02, favourable if effect > 0.02, else neutral
magnitude = |effect|, forced to 0 when neutral, never above 1
```

`magnitude` is the share of monthly revenue lost, or gained, under a severe event. `channels` comes from the classifier's `mechanism`. `sensitivity.source` says where the values came from: `llm`, `fallback` (sector defaults) or `override` (a bank officer edited the profile). While the classifier is still running, the sector defaults are used and a warning says so.

The hazard keys are the climate unit's own (`HAZARDS` in `climate/types.ts`): `river_flood` · `flash_flood` · `heat` · `drought` · `storm` · `cold_wave`.

### 5.2 Stress test (`scoring/stress.ts`)

For each hazard, with `severity` = the hazard's `score` (0 to 1) in the climate profile:

1. `gross shock = severity × magnitude`, negative for an unfavourable hazard, positive for a favourable one.
2. **A gain is capped at +10%** (`favourableCap`), so good weather never rescues a weak business.
3. **Insurance softens a loss.** When the business holds a cover that answers for the hazard, half (`coverShare`) of the *physical* part of the loss is taken off. The part that is customers staying away is not insurable.

   | Cover | Hazards |
   |---|---|
   | `flood` | `river_flood`, `flash_flood` |
   | `storm` | `storm` |
   | `stock` | `river_flood`, `flash_flood`, `storm` |
   | `crop` | all six, but only for `agriculture` |
   | `fire` | none |

   The form records which covers a business holds, not the sum insured, so the offset is a share and not an amount.
4. Revenue becomes `avg_monthly_revenue × (1 + shock)`, and `net_monthly_cashflow`, `dscr`, `surplus_after_debt` and the runway are recomputed with the same function the metrics use. `cash_after_shock` is the cash left after the shock has lasted `duration_months` (default 2).
5. **Breach** when the stressed `dscr < 1` or the stressed runway is under 3 months.

### 5.3 Adjusted score (`scoring/adjusted.ts`)

```
points(hazard) = 20 × |shock|                                  loss or gain
               + 0.6 × (rule score − rule score on the stressed DSCR and runway)   losses only

adjusted = baseline − worst penalty − ½ × next − ¼ × next … + gains
```

- Penalties are sorted worst first and each further one counts for half the one before (`stackDecay`), because hazards rarely strike together.
- Gains are scaled so that together they add at most 3 points (`maxUplift`). **`adjusted` is never above `baseline + 3`**, and never below 0.
- `drivers[]` lists every hazard that moved the score, largest first: `{ hazard, points_change, reason }`. The reason is built from the numbers, for example *"River flood stress (severity 0.8, revenue down 24% after flood and stock insurance) drops DSCR from 4 to 1.6"*. The classifier's wording is never used in it.

All of these numbers are in `FINANCE.stress` and `FINANCE.adjusted`.

---

## 6. Finance profile (output)

Checked against `financeProfileSchema` (`profile/schema.ts`) before it is returned. The schema is strict: an extra key fails with 500 `INVALID_OUTPUT`. Keys are snake_case, as in the rest of the API.

```json
{
  "business_id": "3f6c…",
  "generated_at": "2026-10-09T11:30:00+05:30",
  "model_version": "finance-1",
  "inputs": {
    "snapshot_version": 1,
    "snapshot_as_of": "2026-09-30",
    "snapshot_verified": false,
    "proposed_loan_ids": [],
    "impact_profile_version": 1
  },
  "baseline": {
    "score": 89,
    "band": "low_risk",
    "sub_scores": { "dscr": 100, "runway": 85, "leverage": 85, "volatility": 80, "repayment": 75, "business_age": 100 },
    "source": "rules"
  },
  "metrics": { "avg_monthly_revenue": 100000, "net_monthly_cashflow": 40000, "total_emi": 10000, "dscr": 4, "...": "§3" },
  "climate": {
    "profile_ref": "0.1:19.1:72.9@2026-10-09T11:30:00+05:30",
    "cell_id": "0.1:19.1:72.9",
    "fetched_at": "2026-10-09T11:30:00+05:30",
    "overall_climate_risk": 0.4,
    "grade": "C",
    "confidence": "med"
  },
  "sensitivity": {
    "source": "fallback",
    "hazards": {
      "river_flood": { "direction": "unfavourable", "magnitude": 0.6, "channels": ["operations", "revenue"],
                       "reason": "Sector default for food_beverage: …", "physical": 0.6, "demand": 0 },
      "…": "one entry per hazard"
    }
  },
  "stress": {
    "river_flood": {
      "severity": 0.8, "direction": "unfavourable",
      "shock_pct": -24, "gross_shock_pct": -48, "insurance_applied": ["flood", "stock"],
      "duration_months": 2,
      "stressed_metrics": { "monthly_revenue": 76000, "net_monthly_cashflow": 16000, "dscr": 1.6,
                            "surplus_after_debt": 6000, "cash_runway": "positive_cashflow",
                            "cash_runway_months": null, "cash_after_shock": 90000 },
      "breach": false, "breach_reasons": []
    },
    "…": "one entry per hazard"
  },
  "adjusted": {
    "score": 80,
    "band": "low_risk",
    "drivers": [
      { "hazard": "river_flood", "points_change": -7.2,
        "reason": "River flood stress (severity 0.8, revenue down 24% after flood and stock insurance) drops DSCR from 4 to 1.6" }
    ]
  },
  "summary": "Baseline 89 (low_risk); climate-adjusted 80 (low_risk). Biggest driver: River flood stress …",
  "warnings": ["snapshot_unverified: …", "short_revenue_history: 6 months; …"]
}
```

`climate.profile_ref` is the forecast cell and the forecast run the stress test used; the climate profile itself stays in the climate unit's tables.

When the climate unit fails, `climate` is `null`, `stress` is `{}` and `adjusted` is `null`.

**Every generated profile is stored** in `finance_profiles`: the response as returned, the raw inputs behind it, the snapshot version, the scores, the scorer and the model version. Rows are never updated, so the table is the history for comparisons and for ML training labels.

### Warnings

| Warning | Meaning |
|---|---|
| `snapshot_unverified` | The bank has not verified the financials |
| `short_revenue_history` | Fewer than 12 months of revenue |
| `operating_loss` | Average expenses are above average revenue |
| `impact_profile_pending` | The classifier has not finished; sector defaults were used |
| `sensitivity_sector_defaults` | An unsaved business (`evaluateLocation`) is scored on sector defaults |
| `climate_unavailable` | The climate unit failed; baseline only |
| `ml_scorer_failed` | The ML scorer failed; the rules answered |
| `persistence_failed` | The profile was returned but could not be stored |

---

## 7. Plugging in the ML scorer

`scoring/scorer.ts` defines the one interface a baseline score comes from:

```ts
interface Scorer {
  readonly name: "rules" | "ml";
  score(metrics: FinanceMetrics): Promise<{ result: ScoreResult; fallback: string | null }>;
}
```

`rulesScorer` is the default. `createMlScorer({ url })` is a **stub for the trained model, which is not built**. To use it:

1. Serve the Python model over HTTP. It receives `POST <url>` with `{ "model_version": "finance-1", "metrics": { … §3 … } }` and must answer `{ "score": <0 to 100> }`.
2. Set in `api/.env`:

   ```
   FINANCE_SCORER=ml
   FINANCE_ML_URL=http://localhost:8000/score
   ```

3. Restart the API. It prints `Finance scorer: ml`.

What stays fixed: the band is always taken from our thresholds, the sub-scores stay rule-based so a profile can still be explained, and the stress penalties are always computed with the rules. If the call fails, times out (5 s) or returns something else, the rules answer, `baseline.source` is `rules`, and the profile carries an `ml_scorer_failed` warning. `FINANCE_SCORER=ml` without a URL uses the rules.

| Setting | Default | |
|---|---|---|
| `FINANCE_SCORER` | `rules` | `rules` or `ml` |
| `FINANCE_ML_URL` | none | The model's scoring endpoint |

Both are read by `config.ts`; an invalid value falls back to the default and never stops the API.

---

## 8. Tool-ready functions

For the future advisory agent. All are methods of `createFinanceService(deps)`, exported from `index.ts`. Each returns plain JSON with a short `summary` built from the numbers. The chat itself is not built.

| Function | Use |
|---|---|
| `getFinanceProfile(businessId)` | The full profile (§6). The only one that stores a profile |
| `simulateScenario(businessId, { hazard, severity, duration_months })` | The stress test for a hypothetical event: "what would a severe flood do?". Needs no climate lookup. `duration_months` defaults to 2 |
| `evaluateLocation(businessDraft, lat, lon)` | Scores an unsaved business at a candidate location, for pre-loan "will this work here?" advice. Stores nothing |
| `repaymentCapacity(businessId, { revenue_drop_pct, months })` | The largest EMI the business can carry (at a DSCR of 1.25) and the monthly shortfall, for a backup repayment plan |

Arguments are snake_case, like the API, and are validated: a bad one is a 422 `VALIDATION_FAILED` naming each field.

`businessDraft`:

```json
{
  "sector": "food_beverage",
  "years_in_operation": 6,
  "insurance_covers": ["flood", "stock"],
  "financials": { "monthly_revenue": [410000, "… 6 to 12 months"], "monthly_opex": 310000,
                  "existing_emi_total": 28000, "outstanding_debt": 650000,
                  "cash_balance": 240000, "payment_delays_12m": 1 },
  "loan_request": { "amount": 800000, "tenure_months": 48, "interest_rate": 13 }
}
```

`loan_request` is optional. Without an `emi` it is worked out by amortisation; without an `interest_rate`, 12% is assumed. A draft has no description for the classifier to read, so it is scored on its sector's defaults.

---

## 9. API

Mounted at `/finance`. Every route needs a signed-in user. The routes under a business use the input service's ownership check: an owner reaches only their own businesses, a bank officer reaches all, and anything else is 404 `BUSINESS_NOT_FOUND`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/finance/business/:id/profile` | The finance profile (§6). Computes and stores a new one each time |
| `GET` | `/finance/business/:id/profiles` | Stored profiles, newest first (20): id, time, trigger, snapshot version, scores |
| `POST` | `/finance/business/:id/scenario` | `simulateScenario`. Body: `{ "hazard", "severity", "duration_months"? }` |
| `POST` | `/finance/business/:id/repayment-capacity` | `repaymentCapacity`. Body: `{ "revenue_drop_pct", "months" }` |
| `POST` | `/finance/evaluate-location` | `evaluateLocation`. Body: `{ "business": <draft>, "lat", "lon" }` |
| `GET` | `/finance/demo` | Runs a built-in sample business (a Chennai bakery asking for a loan, `demo.ts`) end to end |

Rate limit: 30 requests a minute per client on `/finance`, on top of the API-wide limit. `Idempotency-Key` is honoured on the `POST`s and is optional; they only compute, and store no profile.

**Creating and editing a business is the input service's API** (`POST /businesses`, `PATCH /businesses/:id`, `POST /businesses/:id/snapshots`, and the loan routes); see its README.

### Triggers from the input service

`server.ts` connects this service to the input service's `FinancePort`:

| Input event | What happens |
|---|---|
| A loan becomes `authorised` | `getFinanceProfile` runs; the row is stored with `trigger: "first_profile"` |
| On a business with an `authorised` or `active` loan, the bank verifies a newer snapshot (or a new one arrives while none is verified) | The same, with `trigger: "recompute"`. An owner's unverified snapshot after a verified one does not rescore |

A profile asked for over the API has `trigger: "request"`. The input service waits up to 15 seconds for a trigger and retries a failed one every 5 minutes.

---

## 10. Errors, degradation and logging

Errors go through the API's one error handler, in the same envelope as the climate unit's.

| Code | HTTP | |
|---|---|---|
| `NO_FINANCIALS` | 409 | The business has no financial snapshot yet |
| `VALIDATION_FAILED` | 422 | A scenario, capacity or draft argument is invalid; `details.fields` names each one |
| `BUSINESS_NOT_FOUND` | 404 | Also for a business that belongs to another owner |
| `OUTSIDE_COVERAGE` and the other coordinate errors | 422 / 400 | From the climate unit's own validator, for `evaluate-location` |
| `INVALID_OUTPUT` | 500 | The profile failed its own schema |
| `UNAUTHORIZED`, `RATE_LIMITED` | 401, 429 | |

**The profile never fails because of climate.** If the climate unit throws, the profile is still returned with the baseline, `adjusted: null` and a `climate_unavailable` warning. The same holds for the ML scorer (the rules answer) and for storing the profile (it is returned with `persistence_failed`).

Every call to one of the four functions writes a row to `finance_request_log`: a request id, the operation, the business id, whether it succeeded and the error code, `sensitivity_source`, `scorer_source`, the `fallbacks` used (`sensitivity_sector_defaults`, `climate_unavailable`, `scorer_rules`), the milliseconds per stage (`stage_ms`: `load_business`, `metrics`, `baseline`, `climate`, `stress`, `adjusted`, `build`, `store`) and the total latency. A failure to write the log is itself only logged.

---

## 11. Folder structure

```
api/src/services/finance/
  index.ts              public surface: createFinanceService, the scorers, the schema
  service.ts            the pipeline of §2 and the four functions of §8
  config.ts             FINANCE: every weight, band, cap and limit; FINANCE_* settings
  metrics/compute.ts    §3 and the amortisation formula
  scoring/
    baseline.ts         §4
    scorer.ts           §7: Scorer, rulesScorer, the ML stub
    sensitivity.ts      §5.1
    stress.ts           §5.2
    adjusted.ts         §5.3
  profile/
    schema.ts           output schema (§6)
    build.ts            assembles and validates the profile; the summary line
  store.ts              finance_profiles and finance_request_log
  demo.ts               the sample business behind GET /finance/demo
  errors.ts
  testing/fixtures.ts   sample inputs and a stand-in climate unit
  README.md

api/src/routes/finance.ts                 the routes
api/src/controllers/finance.controller.ts  the handlers
```

Tables (migration `20261009123252_finance_service`): `finance_profiles`, `finance_request_log`.

---

## 12. Tests

`npm test` runs them with the rest of the API. 100 tests in four files:

| File | Covers |
|---|---|
| `metrics/compute.test.ts` | Each metric, the amortisation EMI, repayment ratings |
| `scoring/scoring.test.ts` | Every band boundary, the baseline, the scorer (ML reply, three kinds of failure), the adjusted score: penalty size, stacking, the uplift cap, the floor, driver wording |
| `scoring/stress.test.ts` | The sensitivity mapping, the shock (unfavourable, favourable cap, neutral, insurance offset), cover matching, stressed metrics and breaches |
| `src/routes/finance.test.ts` | Every route against real Postgres and the real input service: the profile, insurance, the classifier's profile, a bank override, a pending classifier, a requested loan, climate failure, the real climate pipeline on synthetic weather, the ML fallback, access control, rate limit, stored history, the request log, both triggers, ten SMEs entered through the form API, and the three other tools |

The classifier's own tests (valid, invalid-then-valid, double-invalid fallback, with a scripted model) are in `input/classifier/classifier.test.ts`. No test calls OpenAI, Open-Meteo or an ML endpoint.

---

## 13. Open items and differences from the job brief

- **No second form API or classifier.** The brief asked for `POST/GET/PUT /finance/business` and a classifier under `finance/input/`. The input service already provides both, with consent, versioned snapshots and a bank override, so this service reads from it instead. The business fields are therefore the input service's (`profile`, `operations`, a snapshot, loans), not the brief's flat list.
- **The classifier's output shape is the input service's** (`physical`, `demand`, `mechanism`), not the brief's `direction` / `magnitude` / `channels`. §5.1 derives the brief's shape from it, and the profile's `sensitivity` block carries both.
- **`smes.json` is not in the repository.** The integration test enters ten synthetic SMEs through the form API instead. When the file arrives, load it with the input service's `POST /seed/smes`.
- **Insurance has no sum insured** in the form, so a cover takes a fixed share off a loss (§5.2). Add `cover_amount` to the form to cap it properly.
- **Expenses are one monthly average**, as the form collects them; a 12-month expense series would let the stress test fall on the right season.
- **Only the primary location is stress-tested.** Additional locations and suppliers' locations are stored by the input service but not used here.
- **Severity is the climate hazard's `score`**, which blends history and the 7-day forecast. A profile therefore moves a little as the forecast changes; `climate.profile_ref` records which forecast run was used.
- **Each `GET …/profile` stores a new row**, even when nothing changed. Add a "same snapshot, same forecast run" check if the table grows too fast.
- **Weights, bands, the insurance share and the penalty formula are starting assumptions.** Calibrate them once outcomes exist.
- **`/finance/demo` needs a signed-in user**: only `/health` and `/auth` are public. Its first call for the Chennai location can take the 30-year climate download if that cell is not cached yet.
- **The climate trigger of the input service is still not connected.** A new business's cell is screened on its first finance profile instead.
