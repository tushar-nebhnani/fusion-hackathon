# ClimaCredit: who does what, and how to use it

ClimaCredit helps a bank lend to small businesses in India with the weather taken into account. It scores how exposed a business's location is to six hazards (river flood, flash flood, heat, drought, storm, cold wave), combines that with the business's finances, watches the weather while a loan is live, and warns both the owner and the bank when something dangerous is coming.

This guide is for the people who use the app. Setup details, every endpoint and every setting are in the [main README](../README.md).

## The people

| Persona | Their job in ClimaCredit | Signs in as |
| --- | --- | --- |
| **Business owner** | Describes the business, keeps its financial figures current, reads warnings and acts on them | Any Google account |
| **Bank officer** | Records and authorises loans, checks the figures, reads the risk scores and alerts, decides on repayment changes | A Google account listed in `AUTH_BANK_EMAILS` or `AUTH_BANK_DOMAINS` |
| **Operator** | Runs the services, names the bank officers, switches real email on | No account; works on the server |

The app also does four jobs on its own. They are described under [What runs by itself](#what-runs-by-itself).

Everyone not named as a bank officer is an owner. There are no passwords: sign-in is with Google only.

## Business owner

**Your job:** give the bank a true picture of your business, and act when a warning arrives.

What you can do:

1. **Sign in** with Google.
2. **Register your business.** You describe what you sell and to whom, pin your main location, list your suppliers, and say whether you have insurance and backup power. You also choose whether to share the business with the bank; a bank officer cannot open it unless you agree.
3. **See how weather affects you.** The app works out how each hazard would hit your premises and your demand, from your description and sector.
4. **See the climate risk at your location:** an overall grade from A (lowest risk) to E, and a score for each hazard.
5. **Enter your financial figures:** the last 6 to 12 months of revenue, monthly costs, current loan repayments, debt, cash, and late payments. Add a new set whenever they change.
6. **Read your finance profile and evaluation:** a financial health score, what a flood or heatwave would do to it, and one combined rating with the reasons.
7. **Ask the advisor.** Before a loan it explains your risks, when an alert fires it tells you what to do, and after damage it helps you write a recovery plan. It can propose a change to your repayments, but only a bank officer can approve one.
8. **Receive warnings by email**, in English, Hindi or Marathi, with steps to take before the event.

What you cannot do:

- Open another owner's business.
- Record or authorise a loan, or mark your own figures as verified.
- Change your business profile, locations or suppliers once a loan is authorised. Ask the bank; you can still update contacts and add financial figures.

## Bank officer

**Your job:** decide on loans with the weather in view, and look after them while they run.

What you can do, on top of everything an owner can:

1. **Open any business that was shared with the bank**, including ones the bank created.
2. **Verify an owner's financial figures.** Unverified figures are marked as such in every score.
3. **Record a loan** against a business, then read its finance profile: the baseline score, a stress test for each hazard, and the climate-adjusted score with what drives it.
4. **Read the evaluation:** one rating (`favourable`, `acceptable`, `caution`, `unfavourable` or `insufficient_data`) with the checks behind it.
5. **Authorise the loan.** From then on the monitor watches the business's location, and the business's risk-relevant details are locked to bank officers.
6. **Read the alerts** for every business: what was detected, how severe, and the message that was sent.
7. **Decide on the advisor's proposals.** When the advisor proposes a repayment change after an event, you approve or reject it. You also record disbursal and close a recovery.
8. **Correct the weather-impact profile** of a business when the automatic one is wrong.

What to keep in mind:

- **The rules decide; the models inform.** No model output changes the credit score.
- **A business whose owner did not agree to share it is invisible to you**, exactly as if it did not exist.
- **Every write and every refusal is recorded** in an audit trail with your user id.

## Operator

**Your job:** keep the services running and control who is a bank officer.

1. **Start the database and cache:** `docker compose up -d` from the repository root.
2. **Start the API:** `npm run dev` inside `api/`. It listens on port 4000.
3. **Run the web app**, the landing page with the Playground and the owner's Analysis page: `npm run dev` inside `landing/`, then open http://localhost:5173 (landing page), http://localhost:5173/playground or http://localhost:5173/analysis. `VITE_API_URL` in `landing/.env` says where the API is (default `http://localhost:4000`). `http://localhost:5173` is the default in `AUTH_ALLOWED_ORIGINS`; keep it there if you change that setting, and add it to the Google OAuth client's Authorized JavaScript origins, or sign-in is refused (Google answers `Error 400: origin_mismatch`). A host serving the built site must answer `/playground` and `/analysis` with `index.html`.
4. **Name the bank officers** in `api/.env` (`AUTH_BANK_EMAILS`, `AUTH_BANK_DOMAINS`) and restart the API.
5. **Start the background jobs** when you want live watching and warnings: `npm run monitor`, `npm run alerts:worker` and `npm run monitor:verify`, each in its own terminal inside `api/`.
6. **Start the ML service** if the models are wanted: `uvicorn app.main:app --port 8001` inside `ml/`, with `ML_SERVICE_URL=http://localhost:8001` in `api/.env`.

Two switches to know before a demo:

- **Emails are not really sent by default.** `ALERTS_MODE=dry_run` logs and stores each message. Set it to `live` only with SMTP details filled in.
- **`npm run monitor` is real.** It calls the weather provider and queues alerts. Use `npm run monitor:simulate -- --location L1 --scenario heavy-rain` to rehearse.

### Security settings

The full audit, with every risk, control and a manual test plan, is [Security/SECURITY-AUDIT.md](Security/SECURITY-AUDIT.md). What an operator needs to know:

- **`AUDIT_HMAC_KEY`** (32+ random characters, e.g. `openssl rand -hex 32`) signs the audit trail's hash chain. Keep it off the database host. `npm run audit:verify` inside `api/` checks the whole chain and names the first broken event.
- **Bank officers by domain** (`AUTH_BANK_DOMAINS`) count only for accounts that domain's Google Workspace manages. Otherwise list them one by one in `AUTH_BANK_EMAILS`.
- **Sessions last 8 hours.** Taking someone off the bank lists ends all their sessions at their next request.
- **Scores use bank-verified numbers.** Once a bank officer verifies a financial snapshot, an owner's later, unverified figures are kept and shown but move no score until the bank verifies them.
- **Owners can withdraw sharing** with `PATCH /businesses/:id/consent`, except while a loan is authorised or active.
- **New places are capped**: one user can start at most 3 climate lookups for never-screened places per 10 minutes (429 `NEW_PLACE_LIMIT`), because each uses most of the weather provider's shared free allowance.
- **Postgres and Redis listen on `127.0.0.1` only** in Docker Compose, because their passwords are defaults.
- **ML models are pinned**: the ML service loads a model only if its SHA-256 matches `ml/models/checksums.json`. After retraining, commit the model and that file together (`python training/checksums.py` re-pins all).

## What runs by itself

| Part | What it does | Who sees the result |
| --- | --- | --- |
| **Monitor** | Checks the forecast for every business with an authorised or active loan, more often when the forecast worsens, and queues an alert when a threshold is crossed | Owner and bank, through alerts |
| **Alert worker** | Sends each queued alert as two emails, one to the owner and one to the bank. It will not email anyone who has not consented, and it waits 6 hours before repeating the same warning | Owner and bank |
| **Advisor** | A chat assistant that reads the business's evaluation and answers in plain language. Every number it gives must match the system's own figures | Owner and bank |
| **ML models** | Estimate how likely a fired flood or storm alert is to be real, spot a break in a business's revenue pattern, and simulate what the local weather does to a business's chance of missing repayments | Whoever calls `/ml`; the console's Analysis page shows the cash-flow outlook |

## One loan, start to finish

The app in `landing/` has two pages beside the landing page. The **Playground** (`/playground`) follows one loan in eight chapters, each saying what happens, who does it and why it matters. It plays the whole story by itself on example data as soon as it opens (nothing is stored, no email goes out), and "Run it live" replays it against the API for a signed-in bank officer. A terminal docked at the bottom of the page prints every request the story makes as it happens: the call, its body, the status, the time it took and the start of the answer. The **Analysis** page (`/analysis`) is for the people who use the app: the owner fills in one form in two pages (first the business, its location and how it runs, with insurance picked from a dropdown; then its money, with one box per month of sales, and contact and consent; the location is a pin on an OpenStreetMap map, found by address search, a click or the browser's location, and a dropped pin fills in the address and pincode; the form checks the API's rules itself, such as a description of at least 30 characters, and lists what to fix in plain words), and gets one analysis built from the scoring rules (overall rating with reasons, climate grade and hazards, financial score before and after weather, weather impact, repayment headroom if sales fall 30% for 3 months, and the cash-flow outlook) with the advisor chat beside it. The advisor is given everything on the form as the owner's own claims: insurance, power cuts, premises and floor, year started, staff, products, suppliers, cash, debt and late payments. Nothing works signed out: touching any field opens a Sign in with Google pop-up. After sign-in a returning owner goes straight to their own analysis (no business ID to type); a bank officer picks one of the businesses shared with the bank and also gets a collapsed panel of bank tools. It shows no routes, raw answers or settings. To call each endpoint directly, use the Postman collection.

| Chapter | What happens | Who |
| --- | --- | --- |
| 1 | The business applies: profile, location, operations, suppliers, consent | Owner |
| 2 | The app works out how weather moves this business | Automatic |
| 3 | Climate risk at the location: grade and six hazard scores | Automatic |
| 4 | The owner enters financial figures | Owner |
| 5 | The bank records a loan and reads the climate-adjusted score | Bank officer |
| 6 | The bank authorises the loan and pays out; the monitor starts watching | Bank officer |
| 7 | Heavy rain is forecast; the advisor tells the owner what to do first | Monitor, then advisor |
| 8 | The shop floods; the advisor proposes repayment options and the bank decides | Owner, then bank officer |

Chapters 5 to 8 need a bank officer. If you are signed in as an owner, the story stops there and shows the refusal.

If the API is not running, both pages switch to **sample mode**: every step answers with made-up data for one bakery, each answer labelled as a sample, and nothing is sent.

## Reading the numbers

| You see | It means |
| --- | --- |
| Climate grade A to E | Overall weather risk at the location. A is lowest |
| Hazard score 0 to 1 | How exposed the location is to that one hazard |
| Baseline finance score 0 to 100 | Financial health from the owner's figures alone. 70 and above is low risk |
| Climate-adjusted score | The same score after the location's hazards are applied |
| Evaluation rating | One verdict combining climate and finance, with reasons |
| Alert band `low`, `medium`, `high` | How likely a fired flood or storm alert is to be followed by a real event, from past records |
| `delta_pd_climate` | How many points the local weather adds to the chance of falling three months behind on repayments, in a simulation |

## Limits to be honest about

- **The alert model is a ranking aid, not a forecast.** In its high band about 18% of flood alerts and 31% of storm alerts were real in the test years; the rest were false alarms. The storm figure rests on 16 real storms.
- **The cash-flow simulation's city order is measured; its sizes are assumed.** How often floods hit each city comes from 29 years of records. What one flood costs a business is an assumption.
- **The anomaly and credit-default models were built on made-up businesses.** They show the method works, not how real businesses behave.
- **The location picker uses OpenStreetMap's free services.** Map tiles come from tile.openstreetmap.org and address search from Nominatim, which allows about one search a second and asks heavy users to run their own. Fine for a pilot; a busy deployment needs its own geocoder or a paid one.
- **Only the cash-flow outlook has a screen.** The Analysis page shows it; the alert model and the anomaly model are reached through `/ml` only.
- **There is no admin screen.** Bank officers are named in a settings file, and alert contacts for the bank are entered by hand.
- **Heat, drought and cold-wave alerts are rule-only**, because there are no verified records to check them against.

More detail: [main README](../README.md), [model cards](../ml/models/), [assumptions](../ml/data/ASSUMPTIONS.md).
