# ClimaCredit — Alert System

Sends early warnings to **banks** and **business owners** when a sudden climate change is detected near a business, with **preventive guidelines** for each side.

- **Stack:** Node.js + TypeScript. Python is used only for the ML models, and the alert system has no Python in it.
- **Channels:** Email and SMS. WhatsApp is out of scope.

Design rule #1: **the alert system must never slow down, block or crash any other part of ClimaCredit.** If alerts are broken, the API, scoring, the climate tool and the dashboard keep working.

> **Status:** Alerts are triggered automatically by code, never by hand. The trigger is the **background monitor**, which detects a sudden change and calls `enqueue()`. **The background monitor is not built yet.** Until it exists, fire test alerts with the CLI (§11). Section 3 is the contract the monitor must follow.

---

## 1. Where it fits

```
┌──────────────────────────────────────────────────┐
│ Background monitor            [ NOT BUILT YET ]  │
│  • picks locations from the request log          │
│  • re-checks them every 15 min                   │
│  • compares new data with the last profile       │
│  • on sudden change: tighten check frequency,    │
│    update disaster DB, and call enqueue()        │
└──────────────────────────┬───────────────────────┘
                           │  sudden change detected (by code)
                           ▼
┌──────────────────────────────────────────────────┐
│ enqueue(event)          ← the ONLY function other│
│   • builds alert rows   │  modules import        │
│   • inserts into alert_outbox  (one fast INSERT) │
└──────────────────────────┬───────────────────────┘
                           │  (separate Node process)
                           ▼
┌──────────────────────────────────────────────────┐
│ Alert worker   (npm run alerts:worker)           │
│   claim → dedupe → render → send → record        │
│        ├── EmailSender  (nodemailer / SMTP)      │
│        └── SmsSender    (twilio / DLT gateway)   │
└──────────────────────────┬───────────────────────┘
                           ▼
              alert_deliveries table → dashboard "Alerts" tab
```

The monitor **never calls an email or SMS provider directly**. It writes a row and moves on. A separate worker process does the slow, failure-prone network work.

**Why a separate process and not `setInterval` inside the API?** Node runs on one event loop. Slow SMTP handshakes, retries and template rendering inside the API process would compete with user requests, and an unhandled rejection could take the API down. A separate process means the API's event loop never sees sending work.

---

## 2. How it stays out of everyone's way

| Risk to other programs                         | How we prevent it                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slow SMTP/SMS call blocks the API              | **Outbox pattern.** Producers only `INSERT` into `alert_outbox`, taking milliseconds. Sending happens in the worker process.                                                                                                               |
| Provider error crashes the caller              | Every send is wrapped in `try/catch`. A failure is recorded on the alert row, never re-thrown. `enqueue()` **never rejects**: on error it logs and resolves to `false`.                                                                    |
| Unhandled promise rejection kills a process    | The worker registers `process.on('unhandledRejection')` and `process.on('uncaughtException')` to log and keep going (or exit cleanly so the process manager restarts it). Since it's a separate process, the API is unaffected either way. |
| Hanging network call                           | Hard timeouts on every send: SMTP via nodemailer's `connectionTimeout`/`socketTimeout` (10 s), SMS via a `withTimeout()` helper (8 s).                                                                                                     |
| Retry storms                                   | Exponential backoff (1 → 2 → 4 → 8 → 16 min), max 5 attempts, then status `dead`.                                                                                                                                                          |
| Database lock contention                       | Short transactions. The worker claims small batches (≤ 20 rows). For SQLite: WAL mode + `busy_timeout = 5000`.                                                                                                                             |
| Same alert sent twice (two workers, a restart) | **Lease claim:** a row is sent only by the worker that sets `claimed_by` + `lease_until`. Expired leases are re-claimable. A unique `dedupe_key` stops duplicates.                                                                         |
| Spamming owners every 15 minutes               | **Cooldown** per `(business, hazard, severity)` (default 6 h). Only an **upgrade** in severity breaks the cooldown.                                                                                                                        |
| Night-time SMS for minor alerts                | **Quiet hours** (22:00–07:00 IST) for `WATCH`. `CRITICAL` always goes out.                                                                                                                                                                 |
| Bad demo day / no credentials                  | `ALERTS_MODE=dry_run` logs messages and stores them as "sent (dry run)" without calling any provider.                                                                                                                                      |
| Need to switch it all off                      | `ALERTS_ENABLED=false`: `enqueue()` becomes a no-op and the worker idles. Nothing else changes.                                                                                                                                            |
| Worker crashes                                 | It's its own process, so the API keeps running. On restart it resumes from the outbox, and nothing is lost.                                                                                                                                |

---

## 3. When an alert fires (contract for the background monitor)

The alert system does **not** detect anything itself. The background monitor detects a sudden change in code and hands the alert system an event. This keeps detection and delivery separate: the monitor decides **whether** something changed, and the alert system decides **who to tell, how and when**.

What the monitor must do, once built:

1. On each check, compare the fresh data for a location with the **last stored profile** for it.
2. If a rule below matches, that is a **sudden change**: call `enqueue(event)` once per affected business.
3. Don't block on it. Call it as `void enqueue(event)`, or `await` it — it resolves in milliseconds and never rejects, so a broken alert system can't stall monitoring.
4. Send each event even if it might repeat. Duplicates and cooldowns are handled here, by `dedupe_key` and `policy.ts`.

Detection rules (each one counts as a sudden change):

| Trigger                                                               | Example                                                      | Severity   |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ---------- |
| Hazard score rises one band                                           | Flood: Low → Moderate                                        | `WATCH`    |
| Forecast tripwire crossed                                             | Heavy-rain or max-temperature tripwire in the 7-day forecast | `WARNING`  |
| Dormant hazard reactivated                                            | An eliminated hazard's tripwire trips                        | `WARNING`  |
| Tripwire crossed **and** river-discharge / forecast spike within 72 h | Imminent flood near the business                             | `CRITICAL` |

Event type:

```ts
type Severity = "WATCH" | "WARNING" | "CRITICAL";
type Hazard = "flood" | "heat" | "drought" | "storm";

interface AlertEvent {
  businessId: string; // "SME-0142"
  hazard: Hazard;
  severity: Severity;
  windowStart: string; // "2026-10-12" (ISO date)
  windowEnd: string; // "2026-10-14"
  evidence: string; // "Heavy-rain tripwire crossed; river discharge rising"
  sourceRunId: string; // "mon-2026-10-09T15:45"
}
```

`dedupeKey = businessId:hazard:severity:windowStart`

---

## 4. Who gets what

Each event creates **two kinds of alerts**: one for the owner and one for the bank.

### Business owner: "protect your business"

- Short and plain, in the owner's language (`en`, `hi`, `mr`).
- What is coming, when, and 3–4 concrete preventive steps.
- A line saying the bank may contact them with support.
- **No loan amounts, scores or account details in SMS.**

### Bank (loan officer / risk team): "protect the borrower and the loan"

- Borrower, location, hazard, severity, forecast window and evidence.
- Suggested actions to review. These are **suggestions only, never automatic decisions.**
- A link to the borrower page on the dashboard.
- `WATCH` alerts are batched into a **daily digest email**. `WARNING` and `CRITICAL` alerts go out immediately.

### Channel per recipient

| Recipient | Primary | Fallback                                      |
| --------- | ------- | --------------------------------------------- |
| Owner     | SMS     | Email                                         |
| Bank      | Email   | Dashboard alerts tab, which is always written |

---

## 5. Preventive guidelines

Guidelines live in `src/alerts/guidelines.json`, keyed by **hazard → severity → audience**, with optional sector-specific extras. They are content, not code, so they can be edited without touching the worker.

```json
{
  "flood": {
    "WARNING": {
      "owner": [
        "Move stock, machines and records to a higher shelf or floor",
        "Keep important documents in a waterproof bag",
        "Plan to switch off main power if water enters",
        "Back up billing and stock data to your phone or cloud"
      ],
      "bank": [
        "Call the borrower to confirm they received the warning",
        "Check insurance cover on stock and collateral",
        "Pre-approve eligible relief (bridge loan / EMI deferment) per bank policy",
        "Mark account for follow-up after the event"
      ]
    }
  },
  "heat": { "...": "..." },
  "drought": { "...": "..." },
  "storm": { "...": "..." }
}
```

Sector extras, for example `food`: "Check refrigeration and power backup".

Guidelines are general safety advice. Messages end with "Follow instructions from local authorities".

---

## 6. Message templates

Templates live in `src/alerts/templates/`, one per `channel × audience × language`, using simple `{placeholder}` fields.

**SMS → owner (WARNING, en):**

```
ClimaCredit alert: {hazardLabel} risk near {businessName} on {window}. Move stock & records higher, protect documents, back up data. Your bank may contact you with support. Follow local authority advice.
```

**Email → bank (subject):**

```
[WARNING] Flood risk — SME-0142 Sri Ganesh Bakery, Chennai — 12–14 Oct
```

SMS length limits:

- English (GSM-7): 160 characters per segment.
- Hindi/Marathi (Unicode): **70 characters per segment**. Keep these to 2 segments max.

---

## 7. Data model

Written as SQL (SQLite/PostgreSQL). If the project uses MongoDB, the same fields become three collections, with a unique index on `{ dedupeKey, audience, channel }`.

```sql
-- what needs to be sent
CREATE TABLE alert_outbox (
  id            INTEGER PRIMARY KEY,
  dedupe_key    TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('owner','bank')),
  channel       TEXT NOT NULL CHECK (channel IN ('email','sms')),
  hazard        TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('WATCH','WARNING','CRITICAL')),
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed','dead','suppressed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT NOT NULL,
  claimed_by    TEXT,
  lease_until   TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (dedupe_key, audience, channel)
);

-- every attempt, for the dashboard and audit
CREATE TABLE alert_deliveries (
  id            INTEGER PRIMARY KEY,
  outbox_id     INTEGER NOT NULL REFERENCES alert_outbox(id),
  provider      TEXT NOT NULL,              -- smtp | twilio | dry_run
  provider_ref  TEXT,                       -- message id from provider
  result        TEXT NOT NULL,              -- sent | failed
  error         TEXT,
  sent_at       TEXT NOT NULL
);

-- who can be contacted, and whether they agreed
CREATE TABLE alert_contacts (
  id            INTEGER PRIMARY KEY,
  business_id   TEXT,                       -- NULL for bank users
  audience      TEXT NOT NULL CHECK (audience IN ('owner','bank')),
  name          TEXT,
  email         TEXT,
  phone_e164    TEXT,                       -- +91XXXXXXXXXX
  language      TEXT NOT NULL DEFAULT 'en',
  consent_at    TEXT,                       -- NULL = no consent, never send
  opted_out_at  TEXT
);
```

---

## 8. Worker loop

```
every ALERTS_POLL_SECONDS (default 15 s):
  1. claim up to 20 rows: status='pending' AND next_try_at <= now
     (or status='sending' with expired lease)
     → set status='sending', claimed_by=<worker id>, lease_until=now+2 min
  2. for each row (one at a time, each inside try/catch):
       • contact missing / no consent / opted out  → status='suppressed'
       • inside cooldown or quiet hours            → status='suppressed' or delay
       • render template + guidelines
       • send via channel sender (with timeout)
       • success → status='sent', write alert_deliveries
       • failure → attempts+1, next_try_at=backoff, status='pending'
                   (or 'dead' after 5), write alert_deliveries
       • owner SMS dead → enqueue owner email fallback
  3. wait, then repeat  (a polling loop with await, not overlapping setIntervals)
```

The worker shuts down gracefully on `SIGINT`/`SIGTERM`: it stops claiming, finishes the current message, releases the remaining leases and exits.

---

## 9. Folder structure

```
src/alerts/
├── README.md            ← this file
├── index.ts             ← exports enqueue() and types
├── types.ts             ← AlertEvent, Severity, Hazard, ...
├── enqueue.ts           ← builds outbox rows (fast, never rejects)
├── worker.ts            ← entry point for npm run alerts:worker
├── policy.ts            ← cooldown, quiet hours, severity upgrade rules
├── render.ts            ← templates + guidelines → message text
├── withTimeout.ts       ← Promise timeout helper
├── cli.ts               ← test events: npm run alerts:test
├── senders/
│   ├── Sender.ts        ← interface: send(to, subject, body) → Promise<SendResult>
│   ├── emailSmtp.ts     ← nodemailer
│   ├── smsTwilio.ts     ← twilio
│   └── dryRun.ts
├── guidelines.json
├── templates/
│   ├── sms_owner_en.txt
│   ├── sms_owner_hi.txt
│   ├── email_bank_en.html
│   └── ...
└── __tests__/
```

Packages: `nodemailer`, `twilio`, `dotenv`, and your existing DB client.

---

## 10. Configuration (`.env`)

```bash
ALERTS_ENABLED=true
ALERTS_MODE=dry_run            # dry_run | live
ALERTS_POLL_SECONDS=15
ALERTS_COOLDOWN_HOURS=6
ALERTS_QUIET_HOURS=22:00-07:00
ALERTS_TZ=Asia/Kolkata

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_APP_PASSWORD=
ALERTS_FROM_EMAIL=

# SMS
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

Secrets stay in `.env`, which is git-ignored, and are never logged.

---

## 11. Running

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "alerts:worker": "tsx src/alerts/worker.ts",
    "alerts:test": "tsx src/alerts/cli.ts"
  }
}
```

```bash
# API (unchanged)
npm run dev

# Alert worker, in a second terminal
npm run alerts:worker

# Send a test event (dry run) — use this until the background monitor exists
npm run alerts:test -- --business SME-0142 --hazard flood --severity WARNING
```

Producers call:

```ts
import { enqueue } from "./alerts";

void enqueue(event); // resolves true/false in ms, never rejects
```

---

## 12. SMS in India: what works when

| Stage          | Route                                    | Notes                                                                                                                                                                           |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hackathon demo | Twilio trial → **verified numbers only** | International route; the sender shows as a random short code; delivery not guaranteed. The dashboard shows every SMS as a phone-style preview, so the demo never depends on it. |
| Production     | DLT-registered Indian SMS gateway        | Requires company + Sender ID + template registration on the operator DLT portal (takes days). Templates in `templates/` are written to be DLT-registrable.                      |

---

## 13. Privacy and safety

- **Consent first:** no `consent_at` means no message, ever. Every SMS and email includes an opt-out line.
- **Minimal data in messages:** no scores, loan amounts or account numbers in SMS. The bank email links to the dashboard instead of embedding financials.
- **Audit trail:** every attempt is stored in `alert_deliveries`.
- **Human in the loop:** bank suggestions are prompts for a loan officer. The system never changes a loan by itself.
- Designed with India's DPDP Act (consent, purpose limitation) in mind.

---

## 14. Testing checklist

- [ ] `enqueue()` resolves in < 50 ms and never rejects, even when the DB is unavailable
- [ ] Worker killed mid-send → restarted → no lost and no duplicate alerts
- [ ] SMTP/Twilio down → retries with backoff → `dead` after 5 → owner email fallback queued
- [ ] Same event twice within cooldown → second one `suppressed`
- [ ] Severity WATCH → WARNING inside cooldown → sent (upgrade)
- [ ] WATCH at 23:00 → delayed; CRITICAL at 23:00 → sent
- [ ] Contact without consent → `suppressed`
- [ ] Hindi SMS stays within 2 Unicode segments
- [ ] `ALERTS_ENABLED=false` → API, scoring and climate tool behave exactly the same
- [ ] API response times unchanged while the worker is sending a large batch

---

## 15. Known limitations

- SMS delivery in the demo is best-effort (see §12).
- The background monitor that triggers alerts is not built yet (see Status).
- A single worker is enough for the MVP. More workers are safe thanks to lease claims, but have not been tuned.
- Guidelines are static and general. Local-authority feeds (e.g. IMD warnings) could be added later.
