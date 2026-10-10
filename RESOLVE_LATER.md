# To resolve later

Local notes, not committed (listed in `.gitignore`). Written 2026-10-09.

## 1. Open-Meteo rate limit breaks first-time lookups

**Symptom:** `POST /climate/profile` returns 503 "Climate data sources are unavailable" for a
city that has not been screened yet (seen with Bengaluru).

**Cause:** the archive call comes back as HTTP 429, "Minutely API request limit exceeded".
Open-Meteo weights requests by size. One 30-year, 8-variable archive call uses roughly the
whole free per-minute allowance (about 600; this figure is from memory of their weighting
formula and should be checked against their docs). Any other heavy call in the same minute
pushes it over: a second new city, or the river history and projections of the previous one.

**Reproduced:** the same request succeeds on a fresh minute (HTTP 200 in about 4 s) and fails
with 429 when sent right after another full-size call.

**Why it is worse now:** stale data is no longer served (decided 2026-10-09), so a rate-limited
re-screen after 90 days is also a 503, where it used to fall back to the expired profile.

**Where:**
- `api/src/services/climate/open-meteo.ts`, `get()`: retries a 429 after 0.5 s and 1 s, all
  inside the same minute, so the retries cannot succeed.
- `api/src/services/climate/profile.service.ts`, `weatherProfiles()`: throws the 503.
- `api/src/config/climate.ts`, `upstream`: attempts and backoff.

**Options, not yet chosen:**
1. Split the 30-year archive and river-history fetches into two 15-year requests spaced a
   minute apart. Keeps a true 30 years; a first lookup then takes two to three minutes.
2. On 429, wait out the minute before retrying instead of backing off for 1.5 s in total.
3. Return a clear "rate limited, retry in a minute" error with a `Retry-After` header instead
   of the generic 503.
4. Queue heavy calls so only one runs per minute across all requests.
5. Pre-warm the preset demo cities so the demo never triggers a first-time screening.
6. A paid Open-Meteo key, which lifts the limits.

Fetching only 15 years while still describing it as 30 was ruled out: the reasons shown to
lenders and the agent prompt both state about 30 years.

## 2. Hourly and daily caps

Open-Meteo also caps the hour and the day (about 5,000 and 10,000 weighted calls on the free
tier, also from memory). One new location costs on the order of 2,000 across archive, river
history and projections, so a handful of new cities in a session can lock the key out for much
longer than a minute. Not measured yet.

## 3. Confirm what "cache for 6 hours" should cover

Implemented as: weather forecast and river forecast are both cached for 6 hours (the river
forecast was 24), then refetched, never served past that. The 30-year screening profile still
lasts 90 days. If the profile was also meant to expire after 6 hours, every location would
re-download 30 years of history four times a day, which the limits in items 1 and 2 cannot
support.

## 4. Leftovers from removing stale data

- The `stale` value of the response status in `api/prisma/schema.prisma` is no longer written
  by any code. Dropping it needs a migration.
- Expired screening rows stay in Postgres until the next successful re-screen overwrites them.
  Nothing reads them.

## 5. SMS alerts were removed; email is the only channel

Decided 2026-10-09. The alert system (`api/src/services/alerts/`) was built with SMS to the
business owner as its primary channel, as `job.md` describes, and SMS was then taken out.

**Why:** a live test to a real Indian number failed. Twilio answered "Invalid template name.
Trial accounts can only use predefined SMS templates." The trial account authenticated fine
but refuses custom message text, so it cannot carry an alert. The same test's email was
delivered through Gmail SMTP on the first attempt.

**What works today:** the owner and the bank each get an email. Everything else (outbox,
worker, leases, cooldown, retries, bank digest, `GET /alerts`) is unchanged.

**What was removed** (none of it was ever committed, so it has to be rewritten, not restored):
- `senders/smsTwilio.ts`: a `Sender` with `provider: "twilio"` that called
  `client.messages.create({ to, from, body })` and returned the message `sid`. The `twilio`
  package and the `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` settings.
- `templates/sms_owner_en.txt`, `_hi.txt`, `_mr.txt`. The English one was: "Kshetra alert:
  {hazardLabel} risk near {businessName} on {window}. {steps} Your bank may contact you with
  support. Follow local authority advice. Reply STOP to opt out."
- Routing: the owner's first alert was an SMS, and an email was queued as a fallback when the
  owner had no phone number or the SMS failed 5 times.
- Quiet hours (`ALERTS_QUIET_HOURS`, default 22:00-07:00 IST): a `WATCH` SMS at night was held
  until morning; `WARNING` and `CRITICAL` went out at once.
- `smsSegments()` in `render.ts` and its tests: 160 characters per SMS in GSM-7 (153 when
  split), 70 for Hindi or Marathi (67 when split). The Hindi and Marathi texts had to fit two
  segments, 134 characters, and did so with 2 to 14 characters to spare.
- An 8-second timeout per SMS send.

**What was left in place on purpose:**
- The `sms` value of the `AlertChannel` enum and the `alert_contacts.phone_e164` column, so
  bringing SMS back needs no migration. The worker marks any `sms` row `suppressed`.
- `guidelines.json` > `steps`: the one-sentence steps per hazard and language that the SMS
  used. The Hindi and Marathi owner emails use them now.
- `TWILIO_*` and `ALERTS_QUIET_HOURS` lines may still be in a local `api/.env`. Nothing reads
  them; they can be deleted.

**Options for bringing it back, not yet chosen** (provider terms are from memory; check them):
1. Upgrade the Twilio account by adding balance. This lifts the predefined-template limit.
   Delivery to India goes over an international route and is not guaranteed.
2. Fast2SMS "Quick SMS" route: an Indian gateway that has offered a route with no DLT
   registration, at a higher price per message.
3. MSG91 or Textlocal with DLT registration of the company, sender ID and each template. This
   is the production route in India and takes days.

**Where to change it:** add the sender in `senders/`, widen `Channel` in `types.ts`, choose the
owner's channel in `PRIMARY` in `enqueue.ts`, pick the sender by `row.channel` in `worker.ts`
(it takes a single `sender` now), and add the templates. `job.md` sections 2, 4, 6 and 12
still describe the intended SMS behaviour.

