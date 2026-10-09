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
