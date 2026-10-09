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
3. **Serve the web console:** `python3 -m http.server 3000 --directory web`, then open http://localhost:3000.
4. **Name the bank officers** in `api/.env` (`AUTH_BANK_EMAILS`, `AUTH_BANK_DOMAINS`) and restart the API.
5. **Start the background jobs** when you want live watching and warnings: `npm run monitor`, `npm run alerts:worker` and `npm run monitor:verify`, each in its own terminal inside `api/`.
6. **Start the ML service** if the models are wanted: `uvicorn app.main:app --port 8001` inside `ml/`, with `ML_SERVICE_URL=http://localhost:8001` in `api/.env`.

Two switches to know before a demo:

- **Emails are not really sent by default.** `ALERTS_MODE=dry_run` logs and stores each message. Set it to `live` only with SMTP details filled in.
- **`npm run monitor` is real.** It calls the weather provider and queues alerts. Use `npm run monitor:simulate -- --location L1 --scenario heavy-rain` to rehearse.

## What runs by itself

| Part | What it does | Who sees the result |
| --- | --- | --- |
| **Monitor** | Checks the forecast for every business with an authorised or active loan, more often when the forecast worsens, and queues an alert when a threshold is crossed | Owner and bank, through alerts |
| **Alert worker** | Sends each queued alert as two emails, one to the owner and one to the bank. It will not email anyone who has not consented, and it waits 6 hours before repeating the same warning | Owner and bank |
| **Advisor** | A chat assistant that reads the business's evaluation and answers in plain language. Every number it gives must match the system's own figures | Owner and bank |
| **ML models** | Estimate how likely a fired flood or storm alert is to be real, spot a break in a business's revenue pattern, and simulate what the local weather does to a business's chance of missing repayments | Whoever calls `/ml`; not shown in the web console yet |

## One loan, start to finish

The web console is a single page that walks one loan through the whole system. The "Run the whole workflow" button at the top does every step in turn.

| Step | What happens | Who |
| --- | --- | --- |
| 01 | Sign in with Google | Owner or bank officer |
| 02 | The business applies: profile, location, operations, suppliers | Owner |
| 03 | The app works out how weather moves this business | Automatic |
| 04 | Climate risk at the location: grade and six hazard scores | Automatic |
| 05 | The owner enters financial figures | Owner |
| 06 | The bank records a loan and reads the finance profile | Bank officer |
| 07 | The bank authorises the loan; the monitor starts watching | Bank officer |
| 08 | An event hits; the advisor guides the owner and proposes a recovery plan | Owner, then bank officer to decide |
| 09 | What protects every step: rate limits, safe retries, the audit trail | Operator |

Steps 06 and 07 need a bank officer. If you are signed in as an owner, the workflow stops there and shows the refusal.

If the API is not running, the page switches to **sample mode**: it shows built-in example answers, each labelled as a sample, and sends nothing.

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
- **The ML results are reachable through the API but have no screen in the web console yet.**
- **There is no admin screen.** Bank officers are named in a settings file, and alert contacts for the bank are entered by hand.
- **Heat, drought and cold-wave alerts are rule-only**, because there are no verified records to check them against.

More detail: [main README](../README.md), [model cards](../ml/models/), [assumptions](../ml/data/ASSUMPTIONS.md).
