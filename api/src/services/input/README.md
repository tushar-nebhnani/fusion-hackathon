# ClimaCredit — Input Service

The entry point for all data in ClimaCredit. A business owner (or a bank officer on their behalf) enters the business's details through a form, which posts to this service's API. The service validates the input, derives the ratios the scoring units need, and stores everything in versioned form.

- **No file uploads (CSV / statements) in the MVP.** Everything is entered by hand.
- **The `smes.json` seed** uses the same API and validation path, marked `source: synthetic`.
- **The ML model comes later.** This service keeps the **raw entered values** alongside the derived ones, so the model can be trained on the raw data.

## Status

Built and tested as a standalone unit. The routes in §6 are mounted in the API, and everything inside this folder works end to end: validation, consent, derived ratios, versioned storage, the weather-impact classifier, the seed loader.

**Connected:** the finance service and the climate unit. `server.ts` passes the finance service as the `FinancePort`, so an authorised loan and a new snapshot on a live loan each store a finance profile (`api/src/services/finance/README.md`, §9). It passes the climate unit as the `ClimatePort`: `warm(point)` calls `getProfile` with 15 years of history (`CLIMATE.warmHistoryYears`) instead of the usual 30, so a first screening uses less of Open-Meteo's allowance. A warm-up that fails stays a pending job and `retryPending()` delivers it later. The monitor, the alert system and the chat advisor read this service's tables too; the root `README.md` ("How the services connect") says how.

To run it:

```
cd api
npm run db:migrate        # applies 20261009114153_input_service (8 new tables)
npm run dev               # routes are live on http://localhost:4000
npm test                  # tests use the <db>_test database
```

---

## 1. Who uses what

```
                 ┌──────────────────────┐
  Owner / bank ─▶│    Input service     │
  (form / API)   │ validate → derive →  │
                 │ store (versioned)    │
                 └──────────┬───────────┘
                            │ reads
        ┌───────────────────┼────────────────────┬─────────────────┐
        ▼                   ▼                    ▼                 ▼
  Climate unit        Finance service      Background monitor   Alerts
  (lat/lon)           (financials, loan,   (active loans →      (contacts,
                      sector, suppliers)    active cells)        preferences)
```

| Input group | Entered by | Used by |
|---|---|---|
| A. Business profile | Owner | Finance (sector), dashboard |
| B. Locations | Owner | Climate unit, monitor |
| C. Operations | Owner | Finance (outage, mitigation) |
| D. Suppliers | Owner | Climate unit (supplier cells), finance |
| E. Financials | Owner, verified by bank | Finance (snapshot) |
| F. Loan | Bank | Finance, monitor (active cells) |
| G. Contacts & alert preferences | Owner + bank | Alerts |
| H. Consent | Owner | All (gate) |
| I. Outcomes *(later)* | Owner / bank | Verification, ML |
| J. Weather-impact profile | **LLM classifier** (auto, §4); bank can override | Stored for downstream use (finance / advisory decide how to use it) |

---

## 2. Inputs

`R` = required, `O` = optional. Unknown fields are rejected, so a typo in a field name is a 422 and not a silently dropped value.

`POST /businesses` takes the groups under these keys:

```json
{
  "profile":    { "...": "group A" },
  "locations":  { "primary": { "...": "group B" }, "additional_locations": [] },
  "operations": { "...": "group C" },
  "suppliers":  [ { "...": "group D" } ],
  "contacts":   { "owner": {}, "bank_officer": {}, "alerts": {} },
  "consent":    { "data_processing": true, "share_with_bank": true, "alerts": true }
}
```

### A. Business profile (`profile`)

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `name` | string | R | 2–120 chars | |
| `sector` | enum | R | `retail` · `apparel_footwear` · `food_beverage` · `food_processing` · `delivery_ecommerce` · `agriculture` · `construction` · `manufacturing` · `hospitality_tourism` · `logistics` · `entertainment_leisure` · `healthcare_pharmacy` · `home_improvement` · `automotive` · `other` | Coarse category; fallback when the classifier fails |
| `sub_sector` | string | O | ≤ 60 chars | Free text, e.g. "bakery" — classifier input |
| `description` | string | R | 30–500 chars | "What do you sell / do, who are your customers, indoor or outdoor?" — **main classifier input** |
| `products` | list(string) | O | max 10, each ≤ 40 chars | e.g. "ice cream", "cold drinks" — classifier input |
| `sales_channel` | enum | O | `walk_in` · `delivery` · `both` · `b2b` | Foot-traffic vs delivery substitution |
| `indoor_outdoor` | enum | O | `indoor` · `outdoor` · `both` | Indoor vs outdoor substitution |
| `year_started` | int | R | 1950 ≤ y ≤ current year (India time) | → `years_in_operation` |
| `employees` | int | O | ≥ 0 | |
| `udyam_number` | string | O | Udyam format `UDYAM-XX-00-0000000` | MSME registration |
| `gstin` | string | O | 15-char GSTIN format | |

### B. Locations (`locations`)

The **primary location** is where the climate profile is computed. Additional locations count towards mitigation.

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `primary.lat` | number | R | Climate unit's coverage box: 6 ≤ lat ≤ 37 | Map pin / browser geolocation |
| `primary.lon` | number | R | 68 ≤ lon ≤ 98 | |
| `primary.address` | string | R | ≤ 250 chars | Display only |
| `primary.pincode` | string | R | 6 digits, not starting with 0 | Also gives the classifier its city / state |
| `primary.premises` | enum | O | `owned` · `rented` | Affects loss recovery (ML later) |
| `primary.floor` | enum | O | `basement` · `ground` · `upper` | Flood exposure of premises (ML later) |
| `additional_locations[]` | list | O | max 5; each needs lat/lon/address like primary, `pincode` optional | `num_locations` = 1 + length |

Lat/lon checks call the climate unit's own validator (`climate/coordinates.ts`: range, lat-first order, coverage box), so the two services can't disagree on what counts as valid. That is why the bounds above are the climate unit's (`CLIMATE.coverageBbox`) and not a second copy kept here. Valid points are stored rounded to 4 decimals, as the climate unit rounds them. A bad point is reported under the location itself (`locations.primary`, `suppliers.0`), because the validator judges the pair.

### C. Operations (`operations`)

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `power_outage_hrs_month` | int | R | 0–720 | Typical month; utility reliability |
| `has_backup_power` | bool | O | | Reduces outage impact (ML later) |
| `water_dependency` | enum | O | `low` · `medium` · `high` | Drought sensitivity signal |
| `has_insurance` | bool | R | | |
| `insurance_covers` | list(enum) | O | `flood` · `fire` · `storm` · `crop` · `stock`, no repeats | Only if `has_insurance`; otherwise 422 |
| `seasonal_months` | list(int) | O | values 1–12, no repeats | Peak revenue months; overlaps with monsoon matter |

### D. Suppliers (`suppliers`)

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `suppliers[]` | list | R | 1–10 entries | |
| `suppliers[].name` | string | R | ≤ 120 chars | |
| `suppliers[].lat` / `.lon` | number | R | Climate coverage box | Map pin or city pick |
| `suppliers[].share` | number | R | 0 < share ≤ 1; **all shares sum to 1.0 (± 0.02)** | Share of purchases |
| `suppliers[].critical` | bool | O | | No easy substitute; stored as `false` when left out |

Only the top 3 suppliers by share are sent to the climate unit (see the finance README). The rest are stored for later use.

### E. Financials (becomes a snapshot)

Owners don't know their DSCR or volatility, so **they enter raw numbers and the service computes the ratios** (§3).

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `as_of` | date | R | `YYYY-MM-DD`, ≤ today (India time) | Date these numbers describe |
| `monthly_revenue[]` | list(int, INR) | R | **6–12 entries**, each ≥ 0, at least one > 0 | Last N months, oldest first |
| `monthly_opex` | int, INR | R | ≥ 0 | Average monthly operating cost, excluding loan repayments |
| `existing_emi_total` | int, INR | R | ≥ 0 | All current monthly loan repayments |
| `outstanding_debt` | int, INR | R | ≥ 0 | Total principal still owed |
| `cash_balance` | int, INR | R | ≥ 0 | Cash + bank balance today |
| `payment_delays_12m` | int | R | 0–24 | Late EMIs / bills in the last 12 months |
| `receivables_days` | int | O | 0–365 | How long customers take to pay |
| `verified_by_bank` | bool | — | set by bank only | Not accepted in the body (422); set by the verify route. Unverified snapshots are flagged in outputs |

Each submission creates a **new snapshot version**. Edits never overwrite an old snapshot. Verifying a snapshot sets `verified_by_bank`, `verified_by` and `verified_at` on it; the numbers stay as entered.

### F. Loan

Entered by the bank (both loan routes are bank only).

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `amount` | int, INR | R | > 0 | |
| `emi` | int, INR | R | > 0, ≤ `amount` | |
| `tenure_months` | int | R | 1–360 | |
| `interest_rate` | number | O | 0–40 (%) | |
| `purpose` | enum | O | `working_capital` · `equipment` · `expansion` · `other` | |
| `status` | enum | — | `applied` → `authorised` → `active` → `closed` (also `rejected`) | Always starts as `applied`; changed only through `PATCH /loans/:id/status` |

Transitions go forward one step at a time: `applied → authorised | rejected`, `authorised → active | rejected`, `active → closed`. `closed` and `rejected` are final. Anything else is a 409.

**`authorised` / `active` loans define "active cells"** for the background monitor. `service.activeLocations()` returns them (business id, lat, lon of the primary location).

### G. Contacts & alert preferences (`contacts`)

| Field | Type | R/O | Validation | Notes |
|---|---|---|---|---|
| `owner.name` | string | R | | |
| `owner.phone` | string | R | E.164, `+91` + 10 digits | SMS |
| `owner.email` | string | O | email format | |
| `owner.language` | enum | O | `en` · `hi` · `mr` | Alert text language (default `en`) |
| `bank_officer.name` | string | R | | |
| `bank_officer.email` | string | R | email format | |
| `bank_officer.phone` | string | O | E.164 | |
| `alerts.channels` | list(enum) | R | subset of `sms` · `email`, non-empty, no repeats | No WhatsApp |
| `alerts.quiet_hours` | object | O | `{ start: "22:00", end: "07:00" }` IST | Used by alert outbox |

### H. Consent (`consent`)

**Required.** Nothing is stored or scored without it.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `consent.data_processing` | bool | R | Must be `true`, otherwise 403 and nothing is saved |
| `consent.share_with_bank` | bool | R | Must be `true` to have a loan; creating a loan without it is a 403. While `false`, bank officers cannot open a business its owner created |
| `consent.alerts` | bool | R | If `false`, owner gets no alerts (bank still does) |
| `consent.timestamp` | datetime | — | Set by server; rejected if sent |
| `consent.version` | string | — | Consent text version (`consent-1`), set by server; rejected if sent |

### I. Outcomes *(later — for verification and ML)*

Not part of the MVP form and not built. Listed here so the schema leaves room for them.

| Field | Notes |
|---|---|
| `disruption_reports[]` | Owner reports "closed / reduced N days due to X", with dates |
| `actual_revenue_month` | Monthly actuals after onboarding |
| `repayment_events[]` | On time / late / missed per EMI (entered by bank) |

---

## 3. Derived fields

Computed on every snapshot (`derive.ts`). Stored next to the raw values along with a `derivation_version` (`derive-1`).

```
avg_revenue          = mean(monthly_revenue)
revenue_volatility   = stdev(monthly_revenue) / avg_revenue        (coefficient of variation)
NOI_month            = avg_revenue − monthly_opex
operating_margin     = NOI_month / avg_revenue
proposed_loan_emi    = sum of emi over this business's applied / authorised loans
debt_service_month   = existing_emi_total + proposed_loan_emi
dscr                 = NOI_month / debt_service_month               (null if debt_service = 0)
debt_to_revenue      = outstanding_debt / (avg_revenue × 12)
cash_buffer_days     = cash_balance / (monthly_opex / 30)           (null if monthly_opex = 0)
years_in_operation   = current_year − year_started
num_locations        = 1 + len(additional_locations)
```

`stdev` is the population standard deviation (divide by N). Ratios are rounded to 4 decimals, rupee amounts to 2, days to 1.

Edge cases:
- `avg_revenue = 0` → reject the snapshot (`INVALID_FINANCIALS`).
- `NOI_month ≤ 0` → store the value; `dscr` comes out ≤ 0 and the finance service treats it as the highest risk.
- `debt_service_month = 0` → `dscr = null`; the finance scorecard treats that as lowest DSCR risk.

An `active` loan is not added to the debt service: once it is being repaid, the owner's `existing_emi_total` already contains it.

The ratios are fixed at the moment the snapshot is saved. A loan applied for *after* a snapshot does not change that snapshot's `dscr`; the next snapshot picks it up (see §10).

These field names match `smes.json`, so the finance service reads seeded and user-entered businesses the same way.

---

## 4. Weather-impact classifier (LLM)

### 4.1 Why

Weather doesn't only hurt businesses. The same heatwave can hit a business in opposite ways:

| Business | Heatwave | Heavy rain |
|---|---|---|
| Ice-cream parlour | Demand **up** | Foot traffic **down** |
| Food delivery | Orders **up** | Orders **up**, but delivery slows |
| Construction | Work slows | Work **halts** |
| Cinema / mall | Footfall **up** (people escape the heat) | Footfall **up** (indoor substitute) |
| Pharmacy | Rehydration / sunscreen **up** | Cold / flu medicine **up** |

A fixed five-row sector table can't capture this. An LLM reads the business description and produces a **per-business weather-impact profile**.

**Scope:** this service only **produces and stores** the profile. It does not change the climate or finance services' logic. Whether and how the finance service uses the profile is a separate decision for that service.

### 4.2 Two separate effects per condition

For each weather condition, the classifier gives two values, because they behave differently in lending:

- **`physical`** (0 to 1): how much the condition stops the business from operating. This covers premises flooding, work halting, crop loss, stock damage. It is **always a risk** and is never favourable.
- **`demand`** (−1 to +1): how the condition changes what customers buy. Negative means demand drops, positive means demand rises.

Example: a delivery kitchen during heavy rain has `physical: 0.3` (riders slow down) and `demand: +0.6` (more orders).

### 4.3 Conditions

The classifier uses exactly the climate unit's existing six hazard names (imported from `climate/types.ts`, not retyped), so its output lines up with the climate profile without any change to the climate unit:

`river_flood` · `flash_flood` · `heat` · `drought` · `storm` · `cold_wave`

Rain effects on foot traffic and delivery are captured under `flash_flood`. Snow and fog from general weather-impact tables are left out. They aren't in the climate unit, and they barely apply to the target cities.

### 4.4 What the LLM receives

**Sent to the LLM:**
- `sector`
- `sub_sector`
- `description`
- `products`
- `sales_channel`
- `indoor_outdoor`
- `seasonal_months`
- city / state, derived from pincode

**Never sent to the LLM:**
- name
- contacts
- exact lat/lon
- financials
- loan details
- IDs (GSTIN / Udyam)
- the pincode itself

`classifierInputs()` builds this object field by field, so a new field on the business is not sent unless someone adds it there. A test asserts the exact payload.

City and state come from `pincode.ts`: the first two digits of a PIN give the state, the first three give the city for about twenty large cities. Outside those the city is `null`. That is coarse on purpose; the model only needs the region.

The prompt includes a **reference table** of business categories with their favourable conditions, unfavourable conditions and mechanism (stored in `classifier/reference.ts`). It also includes 4 worked examples and a description of the output.

### 4.5 Output schema

```json
{
  "category": "food_beverage",
  "conditions": {
    "heat":        { "physical": 0.2, "demand": 0.7,  "mechanism": "demand_mix",    "confidence": 0.85, "reason": "Cold drinks and ice cream sell more in heat", "source": "llm" },
    "flash_flood": { "physical": 0.5, "demand": -0.5, "mechanism": "foot_traffic",  "confidence": 0.8,  "reason": "Walk-in shop; heavy rain keeps customers home", "source": "llm" },
    "river_flood": { "physical": 0.8, "demand": -0.3, "mechanism": "operational_downtime", "confidence": 0.7, "reason": "Ground-floor premises close during floods", "source": "llm" },
    "drought":     { "...": "..." },
    "storm":       { "...": "..." },
    "cold_wave":   { "...": "..." }
  },
  "overall_confidence": 0.8
}
```

`source` is added by this service, not by the model. It says where a condition's values came from: `llm`, `sector_default` (guardrail 3 or 5) or `override` (the bank).

`mechanism` takes one of these values:
- `demand_timing`
- `demand_mix`
- `foot_traffic`
- `substitution`
- `operational_downtime`
- `production_risk`
- `infrastructure_damage`
- `health_demand`
- `emergency_demand`
- `none`

### 4.6 Guardrails

These follow the same idea as the climate agent: rules set limits, and the LLM fills in detail within them.

1. **Schema validation.** All 6 conditions must be present, every value must be in range, `mechanism` must come from the enum, and `reason` is capped at 200 characters. If validation fails, retry once with the validation errors included. If it fails again, use the fallback.
2. **Physical floor.** `physical` can't go below **0.5 × the sector default**. The LLM can't declare a ground-floor retailer immune to floods. The floor comes from the sector the owner entered, not from the `category` the model picked.
3. **Low confidence.** If a condition's `confidence` is below 0.5, use the sector default for that condition (including the sector's usual demand effect).
4. **Determinism.** Run at temperature 0. The result is cached by `hash(inputs sent) + prompt_version + model`. The same business always gets the same profile.
5. **Fallback.** If the API is down or validation fails twice, use the sector default row with `demand: 0` for every condition and set `status: "fallback"`. `note` says why.

The sector default rows are in `classifier/defaults.ts` (15 sectors × 6 conditions). They are starting assumptions and carry `confidence: 0.3`.

The cache is the `weather_impact_profiles` table itself: before calling the model, the service looks for an `ok` row from any business with the same hash, prompt version and model, and reuses its raw reply. Fallbacks are not cached, so a business that fell back is classified properly on its next run.

### 4.7 Versioning and override

- Results are stored in `weather_impact_profiles` with these fields:
  - `version`
  - `status` (`pending` · `ok` · `fallback` · `overridden`)
  - `model`
  - `prompt_version`
  - `inputs_hash`
  - the raw LLM output (as the model gave it, before the guardrails)
- A bank officer can edit any value. That creates a new version with `status: "overridden"`, `overridden_by` and a reason. The body names only what changes; everything else is carried over from the latest finished version:

  ```json
  { "reason": "Shop is on a raised plinth",
    "category": "retail",
    "conditions": { "river_flood": { "physical": 0.1 } } }
  ```

  The physical floor binds the model, not the bank: an officer may go below it. An override stays the current version until a field the classifier reads changes; then the classifier runs again and its result becomes the newer version.
- Each new version is exposed through `GET /businesses/:id/impact-profile` for any consumer to read.

### 4.8 When it runs

- **On business create:** classification runs asynchronously after the save, without blocking the form.
- **On change:** it reruns when anything it is sent changes: `description`, `sector`, `sub_sector`, `products`, `sales_channel`, `indoor_outdoor`, `seasonal_months`, or a pincode that maps to a different city or state. The check is a comparison of `inputs_hash`, so an edit that changes none of these (a new name, a new phone number) starts nothing.
- **While pending:** the stored profile has `status: "pending"` and `conditions: null`. Saving the business and the other triggers don't wait for it.
- **Forced rerun:** `POST …/reclassify` (bank) creates a new version and skips the cache.
- **After a restart:** a profile left `pending` for more than two minutes is finished by `retryPending()`, which the server runs every 5 minutes.

### 4.9 Model

The classifier uses the OpenAI API through the same SDK as the climate agent (`classifier/openai.ts`), with structured output and `store: false`. The key is `OPENAI_API_KEY`, read on the server only.

| Setting | Default | |
|---|---|---|
| `INPUT_CLASSIFIER_ENABLED` | `true` | `false`, or no API key, means every profile is a fallback |
| `INPUT_CLASSIFIER_MODEL` | `gpt-4.1-mini` | Chosen because it accepts `temperature: 0` |

Reasoning models (`gpt-5*`, `o*`) reject a `temperature`. If one is configured, the request is sent with low reasoning effort instead, and the cache is what keeps a business's profile stable.

### 4.10 Later (ML)

Each classifier output is recorded alongside actual monthly revenue and disruption reports (section I). That data lets the model learn real weather–revenue effects, which can then replace or correct the LLM's estimates.

---

## 5. Flow

```
 form submit
     │
     ▼
 [1] Schema + field validation ──fail──▶ 422 with per-field errors
     │
     ▼
 [2] Consent check ──fail──▶ 403 CONSENT_REQUIRED
     │
     ▼
 [3] Cross-field checks (supplier shares sum, insurance covers, dates,
     lat/lon via climate validator) ──fail──▶ 422 with per-field errors
     │
     ▼
 [4] Derive ratios (§3)
     │
     ▼
 [5] Store (one transaction)
     ├─ business / locations / suppliers / contacts   (upsert)
     ├─ financials → NEW snapshot version             (append only)
     └─ trigger jobs and a pending impact profile
     │
     ▼
 [6] Triggers
     ├─ new business or classifier inputs changed → weather-impact classifier (async, §4; stores profile only)
     ├─ new business or location changed → climate entry function (warms cell cache)
     ├─ loan → authorised                → finance service (first profile);
     │                                     cell becomes active for the monitor
     └─ new snapshot on an authorised / active loan → finance service (recompute; version miss)
     │
     ▼
 [7] Log request (input_request_log)
```

Triggers run **after** the data is saved. If the climate unit or the finance service fails at that step, the input is still accepted. The response comes back with `scoring: "pending"`, and the job is retried.

How that works: step 5 writes each climate / finance trigger as a row in `input_trigger_jobs`, in the same transaction as the data. After the commit the service calls the port and waits up to 15 seconds. On success the job is marked `done` and the response says `scoring: "ok"`. On failure, timeout, or when no port is connected, the job stays `pending` with the error recorded. Pending jobs are tried again on the business's next save and by `retryPending()` every 5 minutes. A newer job of the same kind replaces one still waiting, so a business that moves twice warms only its latest location.

Saves to one business are serialised with a row lock, so two submissions at once still get versions 1 and 2.

---

## 6. API

| Method | Path | Purpose | Who |
|---|---|---|---|
| `POST` | `/businesses` | Create business (A–D, G, H). The caller becomes its owner | signed in |
| `GET` | `/businesses/:id` | Business + latest snapshot + loans + current impact profile | owner of it, bank |
| `PATCH` | `/businesses/:id` | Update profile / operations / contacts | owner of it, bank. With a live loan, profile and operations: bank only |
| `PUT` | `/businesses/:id/locations` | Replace locations (triggers climate) | owner of it, bank. With a live loan: bank only |
| `PUT` | `/businesses/:id/suppliers` | Replace supplier list | owner of it, bank. With a live loan: bank only |
| `POST` | `/businesses/:id/snapshots` | New financial snapshot (E) | owner of it, bank |
| `GET` | `/businesses/:id/snapshots` | Snapshot history, newest first | owner of it, bank |
| `POST` | `/businesses/:id/snapshots/:v/verify` | Bank marks verified | bank |
| `POST` | `/businesses/:id/loans` | New loan (F), status `applied` | bank |
| `PATCH` | `/loans/:id/status` | Status transition, body `{ "status": "authorised" }` | bank |
| `GET` | `/businesses/:id/impact-profile` | Current weather-impact profile + status | owner of it, bank |
| `POST` | `/businesses/:id/impact-profile/reclassify` | Force a rerun; answers 202 | bank |
| `PUT` | `/businesses/:id/impact-profile` | Bank override → new version (`overridden`) | bank |
| `POST` | `/seed/smes` | Load `smes.json` through the same path (dev only) | bank |

**Who is calling.** Every route needs a signed-in user: the session cookie set by `POST /auth/google` (main `README.md`, "Authentication"). Without it the answer is 401 `UNAUTHORIZED`. The role, `owner` or `bank`, comes from the session and cannot be claimed by the caller.

- An owner reaches only the businesses they created; the creator is stored in `businesses.owner_user_id`. Any other business answers 404 `BUSINESS_NOT_FOUND`, exactly like one that does not exist. One check in `inputRouter` covers every path under `/businesses/:id`.
- A bank officer reaches the businesses the bank entered itself and those whose owner agreed to share (`consent.share_with_bank`). Any other answers the same 404. A business created by a bank officer, or by the seed, has no owner, so only bank officers can open it.
- Once a business has a loan that is `authorised` or `active`, its profile, operations, locations and suppliers are the bank's to change: an owner gets 403 `LOCKED_BY_LOAN`. The owner can still change `contacts` and add snapshots. The lock ends when the loan is `closed` or `rejected`.
- Each write and each refused request leaves a row in `audit_events` with the user id, the route and the business, snapshot or loan it was about (main `README.md`, "Authentication").
- `verified_by` and `overridden_by` hold the bank officer's user id.

`PATCH /businesses/:id` takes any of `profile`, `operations`, `contacts`. Fields of `profile` and `operations` are merged one by one into what is stored. Inside `contacts`, each of `owner`, `bank_officer` and `alerts` is replaced whole. The cross-field checks run on the merged result. Consent cannot be changed through it.

Responses: the business routes return the whole business (the six groups, `latest_snapshot`, `loans`, `impact_profile`, `scoring`). Snapshot and loan routes return `{ snapshot, scoring }` and `{ loan, scoring }`.

### Headers

| Header | |
|---|---|
| `Idempotency-Key` | **Required on every `POST`, `PUT` and `PATCH`** here (400 `MISSING_IDEMPOTENCY_KEY` without it). A repeat with the same key returns the first response with `Idempotency-Replayed: true` and does not run again. |
| `Cookie` | The `fusion_session` cookie. The `X-Actor-Role` and `X-Actor-Id` headers that stood in for it are gone and are ignored. |

The routes are rate limited to 60 requests a minute per client, on top of the API-wide limit.

### Errors

Errors go through the API's one error handler, so they have the same envelope as the climate unit's:

```json
{ "error": { "code": "VALIDATION_FAILED",
             "message": "Some fields are invalid",
             "step": "cross_field_validation",
             "details": { "fields": { "suppliers": "shares sum to 0.85, must be 1.0" } } } }
```

| Code | HTTP | |
|---|---|---|
| `VALIDATION_FAILED` | 422 | `details.fields` maps each field path to its problem |
| `INVALID_FINANCIALS` | 422 | Revenue history is all zeros |
| `CONSENT_REQUIRED` | 403 | |
| `UNAUTHORIZED` | 401 | No session, or it has ended |
| `FORBIDDEN` | 403 | A bank route called by an owner |
| `INVALID_STATUS_TRANSITION` | 409 | `details` has `from`, `to` and the `allowed` next statuses |
| `BUSINESS_NOT_FOUND` | 404 | Also for a business that belongs to another owner, or that is not shared with the bank |
| `LOCKED_BY_LOAN` | 403 | An owner changing profile, operations, locations or suppliers while a loan is authorised or active |
| `LOAN_NOT_FOUND` | 404 | |
| `SNAPSHOT_NOT_FOUND` | 404 | |
| `SEED_FILE_NOT_FOUND` | 404 | |
| `INVALID_SEED_FILE` | 422 | The seed file is not a JSON array |
| `MISSING_IDEMPOTENCY_KEY` | 400 | |
| `RATE_LIMITED` | 429 | |

### Seeding

`POST /seed/smes` reads the file named by `INPUT_SEED_FILE` (default `data/smes.json`, relative to `api/`). The route does not exist when `NODE_ENV=production`. **`smes.json` is not in the repo yet**; the loader expects a JSON array of entries shaped like this:

```json
[
  { "external_id": "sme-001",
    "business": { "...": "body of POST /businesses" },
    "snapshot": { "...": "body of POST /businesses/:id/snapshots (optional)" },
    "loan":     { "...": "body of POST …/loans (optional)", "status": "active" } }
]
```

Each entry goes through the same service calls as a form submission. `loan.status` is reached by walking the loan through the transitions. The loan is created before the snapshot, so the snapshot's debt service counts a loan that is still only applied for. An entry whose `external_id` is already stored is skipped, so the seed can be run again. A bad entry is reported with its error and left out whole; the rest still load. The response is `{ total, created, skipped, failed: [...] }`.

Seeded businesses get their **sector defaults** and no model call (`status: "fallback"`). Send `{ "classify": "llm" }` to classify them with the model instead; entries are then classified one at a time.

---

## 7. Form layout (for the UI)

Six steps.

1. **Business:** profile (A), including the description and products for the classifier, + consent (H)
2. **Location:** map pin for the primary location, then any additional ones (B)
3. **Operations:** power, water, insurance, season (C)
4. **Suppliers:** add 1–10, with a live share-sum check (D)
5. **Financials:** 6–12 monthly revenue boxes, opex, EMIs, debt, cash (E). Derived ratios preview live.
6. **Contacts & alerts:** (G)

Steps 1–4 and 6 are one `POST /businesses`; step 5 is `POST /businesses/:id/snapshots` afterwards. There is no draft endpoint: the service stores only complete, valid businesses, so the form keeps its draft in the browser until submit.

The loan (F) is entered on the **bank side**, not in the owner's form.

After submission, the owner sees their weather-impact profile as a simple card, e.g. "Heat: good for you · Flash flood / heavy rain: hurts walk-ins · River flood: high risk". The bank sees the full profile with an override button. The profile is `pending` for a few seconds after the first save; poll `GET /businesses/:id/impact-profile` until it is not.

---

## 8. Folder structure

```
api/src/services/input/
  index.ts            route handlers (inputRouter)
  service.ts          the flow of §5: one function per route
  schemas/            one schema per input group (A–H)
  validation.ts       field + cross-field checks (reuses climate lat/lon validator)
  derive.ts           §3
  store.ts            upserts + append-only snapshots, profiles, trigger jobs
  triggers.ts         climate / finance ports and the job runner
  classifier/
    index.ts          classify(business) → validated profile
    prompt.ts         system prompt + examples (versioned: prompt_version)
    reference.ts      category → favourable / unfavourable / mechanism table
    schema.ts         output JSON schema + range checks, override body
    guard.ts          physical floor, confidence fallback
    defaults.ts       sector default rows (fallback)
    openai.ts         the model call
  pincode.ts          pincode → city / state
  seed.ts             smes.json loader
  config.ts           constants and INPUT_* settings
  errors.ts
  testing/fixtures.ts valid request bodies, scripted model and ports for tests
  README.md
```

Tables (migration `20261009114153_input_service`): `businesses`, `business_locations`, `business_suppliers`, `financial_snapshots`, `loans`, `weather_impact_profiles`, `input_trigger_jobs`, `input_request_log`. The profile, operations, contacts and consent groups are stored as the validated JSON that was submitted; locations, suppliers, snapshots and loans have their own rows.

---

## 9. Tests

`npm test` runs them with the rest of the API. 198 tests in six files:

| File | Covers |
|---|---|
| `validation.test.ts` | Every field rule in §2, per-field error paths, cross-field checks, India-time dates, pincode lookup |
| `derive.test.ts` | Each formula in §3 and its edge cases |
| `classifier/classifier.test.ts` | Output schema, the four worked examples, sector defaults, both guardrails, what is sent to the model, hashing, retry, fallback, cache |
| `classifier/openai.test.ts` | The request sent to OpenAI (temperature, `store: false`), refusals, cut-off replies |
| `index.test.ts` | Every route against a real Postgres: status codes, consent, versioning under concurrent writes, loan transitions, triggers and retries, the classifier lifecycle, override, idempotency, rate limit, request log |
| `seed.test.ts` | The loader and `POST /seed/smes` |

The model and the climate and finance services are stand-ins in tests (`testing/fixtures.ts`); no test calls OpenAI.

---

## 10. Open items

- **Handing a business to an owner.** A business the bank or the seed created has no owner, and nothing in the API sets one; edit `businesses.owner_user_id` by hand until there is an invite or claim step.
- **`smes.json`** is not in the repo, and its field layout was not available when the loader was written. If it differs from the entry shape in §6, convert the file or adjust `seedEntrySchema`.
- **Ratios when a loan arrives after the snapshot.** A snapshot's `dscr` is fixed when it is saved. Decide whether applying for a loan should write a fresh snapshot, or whether finance recomputes with `deriveFinancials`.
- Whether unverified snapshots can drive a loan decision, or only alerts.
- **Consent withdrawal.** Consent is recorded at creation and cannot be changed through the API yet.
- Hindi/Marathi alert templates if `owner.language` is kept.
- **Sector default rows and the 0.5 floor** are starting assumptions; tune them once outcomes (section I) exist.
- **Revenue volatility** uses the population standard deviation. Confirm that matches how `smes.json` was generated.
