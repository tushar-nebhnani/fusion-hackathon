# EDA and features (no training here)

Training is done by the backend engineer. This folder stops at model-ready tables.

```bash
PY=ml/.venv-data/bin/python
$PY ml/features/spine.py             # -> data/spine.csv (cell -> IFI districts, coastal, region)
$PY ml/features/build_events.py      # -> data/events_flood.csv, events_storm.csv (ground truth)
$PY ml/features/build_population.py  # -> data/synthetic_businesses.csv (ALL SYNTHETIC, models 5/6)
$PY ml/eda/eda.py                    # prints checks, figures in ml/eda/figures/
$PY ml/features/alerts.py            # -> data/features_flood.csv, features_storm.csv (model 4)
```

`features_flood.csv` / `features_storm.csv`: one row per alert episode (consecutive tripwire days in a cell), with `start`, `end`, a `split` column (train 1995–2015, val 2016–2019, test 2020–2023), the feature columns (`FLOOD_FEATURES` / `STORM_FEATURES` in `features/alerts.py`) and `label` (1 if a real event falls in start − 1 day … end + 3 days). Percentile thresholds and climatology come from training years only, so val and test do not leak. Flood: 6,823 episodes, 8.6 % positive. Storm: 2,565 episodes, 2.5 % positive, so weight classes or use average precision.

EDA findings that shaped the features: floods follow locally extreme rain (median flood sits at the cell's 96th percentile of 3-day rain), and the IMD 64.5 mm rule catches only 20 % of floods on this 0.5° data against 55 % for the cell's own p95. That is why the tripwires and features are relative. IFI reporting jumps in 2021–23, and river discharge is 94 % empty, so it is not a feature.

`build_events.py` reads two downloads kept out of git in `data/external/`: `ifi/India_Flood_Inventory_v3.csv` (India Flood Inventory, IFI-Impacts) and `ibtracs/ibtracs.NI.list.v04r01.csv` (IBTrACS North Indian basin). Its outputs are committed, so you only need these to rebuild them.

`weather_dataset.csv` (55 MB) is committed. Rebuild it with the commands below to refresh it.

# Weather dataset for the hazard early-warning model

## Fast path used for the hackathon (2026-10-10)

The full Open-Meteo download needs ~75,600 weighted calls against a free limit of 10,000 a day, which is more than 7 days. So the dataset in use was built like this:

- **Weather: NASA POWER** (`fetch_power.py`). It is free, needs no key, and returns 1995–present in one request per location. All 38 locations download in about 4 minutes. The source is MERRA-2 / IMERG on a ~0.5° grid, requested at the snapped 0.1° cell centre, with days in local solar time.
- **River discharge: GEOGLOWS v2** (`fetch_geoglows.py`). This is ECMWF's free global river model: no key, daily from 1940, one request per river reach, about 40 s per location. The reach directly under a city is often a side stream, so the fetcher looks up the reaches at the point and at 8 points about 5.5 km around it, and keeps the one with the largest mean flow (`river_discharge`). The reach under the point is kept too (`river_discharge_local`). For Guwahati this finds the Brahmaputra (mean ~18,500 m³/s) instead of a 7.8 m³/s stream. The chosen river ids are in `raw/<location>/geoglows.json`. Days are UTC.

```bash
PY=ml/.venv-data/bin/python
$PY ml/data/fetch_power.py           # weather, all locations
$PY ml/data/fetch_geoglows.py        # river discharge, all locations (~25 min)
$PY ml/data/fetch_power.py --merge   # -> weather_dataset.csv
$PY ml/data/fetch_weather.py --validate
```

POWER columns (units as converted):

| Column | Unit | From POWER |
| --- | --- | --- |
| `temperature_2m_max`, `_min`, `_mean` | °C | T2M_MAX, T2M_MIN, T2M |
| `apparent_temperature_max` | °C | Steadman formula from T2M_MAX, RH2M, WS10M (an estimate) |
| `precipitation_sum` | mm | PRECTOTCORR |
| `wind_speed_10m_max`, `_mean` | km/h | WS10M_MAX, WS10M (m/s × 3.6) |
| `relative_humidity_2m_mean` | % | RH2M |
| `dew_point_2m_mean` | °C | T2MDEW |
| `surface_pressure_mean` | hPa | PS (surface pressure, not sea level) |
| `soil_wetness_top`, `soil_wetness_root` | 0–1 fraction | GWETTOP, GWETROOT (not m³/m³) |
| `shortwave_radiation_sum` | MJ/m² | ALLSKY_SFC_SW_DWN |
| `et0_hargreaves` | mm | Hargreaves–Samani from temperature and TOA_SW_DWN |
| `river_discharge` | m³/s | GEOGLOWS, largest reach within ~5.5 km |
| `river_discharge_local` | m³/s | GEOGLOWS, reach under the point |

Compared with the live API's variables, POWER has **no wind gusts, no `precipitation_hours` and no `rain_sum`**. For the storm hazard, use `wind_speed_10m_max`, which is sustained wind and so reads lower than gusts; a 60 km/h gust threshold does not carry over. Also, a ~0.5° cell smooths out local extremes compared with ERA5's 0.25°.

Validation on 2026-10-10: 440,762 rows, 38 locations, 1995-01-01 to 2026-10-03, no missing dates and no duplicates. Flagged values (kept): Leh's minimum down to −36 °C, which is real at high altitude, and 25 apparent-temperature values of 55–59 °C on the humid east coast. Kavaratti's `soil_wetness_root` is empty because the point is sea.

The rest of this file describes the full Open-Meteo path (`fetch_weather.py`), which still works if there is time to run it.

`fetch_weather.py` downloads raw daily weather and river discharge, from 1995-01-01 to today − 7 days, for every location in `locations.json`, and writes `weather_dataset.csv`. It only fetches data. It does not compute hazard labels or train anything.

## What the API's climate unit uses (read from `api/`, not changed)

**The six hazards** (`HAZARD_CATALOG` in `api/src/services/climate/hazards.ts`) and the Open-Meteo variables each one is screened on:

| Hazard key | What it is | Screening variables | Upstream |
| --- | --- | --- | --- |
| `river_flood` | River overflow | `river_discharge` | Flood API |
| `flash_flood` | Urban / heavy-rain flooding | `precipitation_sum`, `precipitation_hours` | Archive |
| `heat` | Extreme and humid heat | `temperature_2m_max`, `apparent_temperature_max` | Archive |
| `drought` | Rainfall deficit | `precipitation_sum`, `et0_fao_evapotranspiration` (+ soil moisture in forecasts) | Archive |
| `storm` | Cyclone / strong wind | `wind_gusts_10m_max`, `wind_speed_10m_max` | Archive |
| `cold_wave` | Extreme cold | `temperature_2m_min` | Archive |

The live archive request (`ARCHIVE_VARIABLES`) asks for exactly the eight archive variables above. Every one of them is in this dataset.

The cut-offs in `LIMITS` that the labelling step will need are: heat > 40 °C (severe 45), cold < 4 °C (severe 0), gusts > 60 km/h (severe 90), heavy rain ≥ 50 mm/day, a minimum 3-day rain event of 30 mm, and drought when June–September rain is below 75 % of normal.

**Grid snapping** (`api/src/services/climate/grid.ts`, `CLIMATE.grid` in `api/src/config/climate.ts`): archive and climate data use 0.1°, flood data uses 0.05°. A coordinate snaps to `Math.round(value / res) * res`. JavaScript rounds halves upward, so the Python port uses `floor(x / res + 0.5)`. All 43 entries were checked against the JS code and give the same cell ids.

**The eight preset cities** (`CITIES` in `web/app.js`): Guwahati, Mumbai, Delhi, Chennai, Jaisalmer, Srinagar, Puri, Bengaluru.

## Locations

`locations.json` lists the 8 presets plus every state and union-territory capital (`"source": "preset" | "capital"`). Entries that snap to the same 0.1° cell are merged, so 43 entries become **38 unique cells**:

- Mumbai, Chennai, Bengaluru and Srinagar are both presets and capitals, so each becomes one row.
- Delhi and New Delhi have the same coordinates. They become one row named `Delhi`, with New Delhi as an alias.
- **Dispur and Guwahati are not merged.** They are about 5 km apart and snap to neighbouring cells (91.8 and 91.7), so each has its own row.

The `lat`/`lon` columns hold the raw coordinates and `cell_lat`/`cell_lon` the snapped 0.1° cell. Flood data is fetched at the 0.05° cell, which is also what the live API uses.

Empty discharge is expected at some places. Islands (Kavaratti, Sri Vijaya Puram) have no GloFAS river cell, and neither do some hill capitals. Also note that a 0.05° cell is often a small tributary rather than the main river: Guwahati's flood cell returns about 0.5 m³/s, not the Brahmaputra. This is the same cell the live API scores.

## Columns and units

`weather_dataset.csv`: one row per location per day, sorted by `location_name`, `date`. Daily values are IST days (`timezone=Asia/Kolkata`).

| Column | Unit |
| --- | --- |
| `location_name`, `lat`, `lon`, `cell_lat`, `cell_lon` | name, degrees |
| `date` | `YYYY-MM-DD` |
| `temperature_2m_max`, `_min`, `_mean`, `apparent_temperature_max` | °C |
| `precipitation_sum`, `rain_sum` | mm |
| `precipitation_hours` | hours |
| `wind_speed_10m_max`, `wind_gusts_10m_max` | km/h |
| `wind_direction_10m_dominant` | ° |
| `et0_fao_evapotranspiration` | mm |
| `relative_humidity_2m_mean` | % |
| `pressure_msl_mean` | hPa |
| `soil_moisture_0_to_7cm_mean` | m³/m³ |
| `river_discharge`, `river_discharge_max` | m³/s |

All 14 archive variables were accepted by the API on 2026-10-10. If one stops being accepted, the probe drops it, logs a warning and records it under `dropped` in `progress.json`. Open-Meteo's docs describe `river_discharge_max` as an ensemble statistic for forecasts. In practice it still came back populated for historical dates, so treat it as unreliable.

## How long it takes

Open-Meteo's free tier allows 600 calls a minute, 5,000 an hour and **10,000 a day**. Calls are weighted: a request counts as (days ÷ 14) × (variables ÷ 10, if more than 10). One year of the 14 archive variables counts as about 36.5 calls, and one year of flood data as about 26.

| | |
| --- | --- |
| Requests (one per location, year and API) | 2,432 |
| Weighted calls | ~75,600 |
| Duration at the default budget (8,000/day) | **~9.4 days** |
| Duration at the full free allowance (`--daily-budget 10000`) | ~7.6 days |
| Duration at `--daily-budget 7000` (used for the run started 2026-10-10) | ~10.8 days |

The default budget is 4,000 calls an hour and 8,000 a day. It leaves room for the API dev server, which shares the same IP and needs about 600 calls for its first screening of a new place. The fetcher counts every call's weight in a rolling ledger in `progress.json`, so it stays under the budget even after a restart. When the budget is used up it sleeps, logs `budget wait`, and carries on.

## How to run

```bash
# one-time setup (this machine has no ensurepip, hence --without-pip + get-pip)
python3 -m venv --without-pip ml/.venv-data
curl -sSL https://bootstrap.pypa.io/get-pip.py | ml/.venv-data/bin/python
ml/.venv-data/bin/pip install -r ml/requirements.txt

PY=ml/.venv-data/bin/python

$PY ml/data/fetch_weather.py --dry-run                        # 1 location, 1 year, prints only, writes nothing
$PY ml/data/fetch_weather.py --dry-run --location Kavaratti --year 2010

nohup $PY ml/data/fetch_weather.py > ml/data/run.out 2>&1 &   # full run in the background
tail -f ml/data/fetch.log                                     # progress and ETA

$PY ml/data/fetch_weather.py --retry-failed                   # only chunks marked failed
$PY ml/data/fetch_weather.py --merge                          # raw chunks -> weather_dataset.csv
$PY ml/data/fetch_weather.py --validate                       # coverage, NaN, range report
```

Options: `--delay` (minimum seconds between requests, default 2.5), `--hourly-budget`, `--daily-budget`, `--start`, `--end`.

## How to resume

Each completed (location, year, API) chunk is written to `raw/<location>/<api>_<year>.csv` and recorded in `progress.json`. Every write goes to a temporary file first and is then renamed, so a crash cannot leave half a chunk. To resume, run the same command again: finished chunks are skipped, and nothing is ever appended, so a re-run cannot duplicate rows. `--merge` also removes duplicates on `(location_name, date)`.

Retries: on a 5xx, a timeout or a non-quota 429, the fetcher backs off exponentially with jitter, up to 6 attempts. After that it marks the chunk `failed` and moves on. A 429 that says a minute, hour or day quota is used up does not count as an attempt; the fetcher sleeps (1 min, 10 min or 1 h) and tries again. A 400 that says there is no data at the point is stored as an empty chunk, not as a failure.

Files: `fetch.log` (progress, ETA, retries, failures), `run.out` (stdout of a nohup run), `progress.json` (chunk status, accepted variables, call ledger). The data files are git-ignored (`ml/.gitignore`).
