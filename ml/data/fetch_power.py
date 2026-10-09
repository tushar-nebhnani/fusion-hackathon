"""Fast path: daily weather from NASA POWER (free, no key, all years in one
request per location), joined with GEOGLOWS river discharge from
fetch_geoglows.py. See README.md.

    python ml/data/fetch_power.py            # fetch every location (skips ones already saved)
    python ml/data/fetch_power.py --merge    # raw/*/power.csv + raw/*/flood_*.csv -> weather_dataset.csv
    python ml/data/fetch_weather.py --validate
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import random
import sys
import time

import pandas as pd
import requests

from fetch_weather import (DATASET_FILE, HISTORY_START, LOG_FILE, RAW_DIR,
                           atomic_write, default_end_date, load_locations)

URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
# MERRA-2 / IMERG based; units as returned by community=AG
PARAMETERS = ["T2M", "T2M_MAX", "T2M_MIN", "PRECTOTCORR", "RH2M", "T2MDEW", "WS10M_MAX",
              "WS10M", "PS", "GWETTOP", "GWETROOT", "ALLSKY_SFC_SW_DWN", "TOA_SW_DWN"]
FILL = -999.0
DELAY_S = 2.0
MAX_ATTEMPTS = 6

# Output columns, named like the Open-Meteo ones where the meaning matches
WEATHER_COLUMNS = [
    "temperature_2m_max", "temperature_2m_min", "temperature_2m_mean",
    "apparent_temperature_max", "precipitation_sum", "wind_speed_10m_max",
    "wind_speed_10m_mean", "relative_humidity_2m_mean", "dew_point_2m_mean",
    "surface_pressure_mean", "soil_wetness_top", "soil_wetness_root",
    "shortwave_radiation_sum", "et0_hargreaves",
]

# From fetch_geoglows.py: largest reach within ~5 km, and the reach under the point
RIVER_COLUMNS = ["river_discharge", "river_discharge_local"]

log = logging.getLogger("fetch_power")


def apparent_temperature_c(t_c: pd.Series, rh: pd.Series, wind_ms: pd.Series) -> pd.Series:
    """Steadman / Australian BoM apparent temperature, as Open-Meteo uses."""
    vapour_hpa = rh / 100 * 6.105 * (17.27 * t_c / (237.7 + t_c)).apply(math.exp)
    return (t_c + 0.33 * vapour_hpa - 0.70 * wind_ms - 4.0).round(2)


def to_frame(payload: dict) -> pd.DataFrame:
    p = payload["properties"]["parameter"]
    raw = pd.DataFrame(p).replace(FILL, math.nan)
    raw.index = pd.to_datetime(raw.index, format="%Y%m%d")
    out = pd.DataFrame(index=raw.index)
    out["temperature_2m_max"] = raw.T2M_MAX
    out["temperature_2m_min"] = raw.T2M_MIN
    out["temperature_2m_mean"] = raw.T2M
    # Daily max temperature with daily mean humidity and wind: an estimate
    out["apparent_temperature_max"] = apparent_temperature_c(raw.T2M_MAX, raw.RH2M, raw.WS10M)
    out["precipitation_sum"] = raw.PRECTOTCORR
    out["wind_speed_10m_max"] = (raw.WS10M_MAX * 3.6).round(2)  # m/s -> km/h
    out["wind_speed_10m_mean"] = (raw.WS10M * 3.6).round(2)
    out["relative_humidity_2m_mean"] = raw.RH2M
    out["dew_point_2m_mean"] = raw.T2MDEW
    out["surface_pressure_mean"] = (raw.PS * 10).round(2)  # kPa -> hPa
    out["soil_wetness_top"] = raw.GWETTOP
    out["soil_wetness_root"] = raw.GWETROOT
    out["shortwave_radiation_sum"] = raw.ALLSKY_SFC_SW_DWN
    # Hargreaves-Samani; TOA_SW_DWN is extraterrestrial radiation in MJ/m2/day
    spread = (raw.T2M_MAX - raw.T2M_MIN).clip(lower=0)
    out["et0_hargreaves"] = (0.0023 * (raw.T2M + 17.8) * spread.pow(0.5)
                             * 0.408 * raw.TOA_SW_DWN).round(2)
    out.index.name = "date"
    return out.reset_index().assign(date=lambda d: d.date.dt.strftime("%Y-%m-%d"))


def fetch(lat: float, lon: float, start: str, end: str) -> dict:
    params = {
        "parameters": ",".join(PARAMETERS), "community": "AG",
        "latitude": lat, "longitude": lon,
        "start": start.replace("-", ""), "end": end.replace("-", ""),
        "time-standard": "LST", "format": "JSON",
    }
    reason = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = requests.get(URL, params=params, timeout=180)
            if r.status_code == 200:
                return r.json()
            reason = f"{r.status_code}: {r.text[:200]}"
            if r.status_code < 500 and r.status_code != 429:
                raise RuntimeError(reason)
        except requests.RequestException as exc:
            reason = f"{type(exc).__name__}: {exc}"
        backoff = min(120, 2 ** attempt * 2) * random.uniform(0.7, 1.3)
        log.warning("retry %d/%d in %.0fs: %s", attempt, MAX_ATTEMPTS, backoff, reason)
        time.sleep(backoff)
    raise RuntimeError(f"gave up after {MAX_ATTEMPTS} attempts: {reason}")


def run(args: argparse.Namespace) -> None:
    end = args.end or default_end_date().isoformat()
    locations = load_locations()
    failed = []
    log.info("power: %d locations, %s..%s, one request each", len(locations), args.start, end)
    for i, loc in enumerate(locations, 1):
        path = RAW_DIR / loc.slug / "power.csv"
        if path.exists() and not args.force:
            log.info("power %d/%d %s: already saved, skipped", i, len(locations), loc.name)
            continue
        try:
            frame = to_frame(fetch(loc.cell_lat, loc.cell_lon, args.start, end))
        except (RuntimeError, KeyError, ValueError) as exc:
            failed.append(loc.name)
            log.error("power %d/%d %s FAILED: %s", i, len(locations), loc.name, exc)
            continue
        atomic_write(path, frame.to_csv(index=False))
        log.info("power %d/%d %s: %d days", i, len(locations), loc.name, len(frame))
        time.sleep(DELAY_S)
    log.info("power: done, %d failed %s. Re-run to retry them.", len(failed), failed or "")


def merge(_args: argparse.Namespace) -> None:
    frames = []
    for loc in load_locations():
        folder = RAW_DIR / loc.slug
        power = folder / "power.csv"
        if not power.exists():
            log.warning("merge: no power.csv for %s, skipped", loc.name)
            continue
        w = pd.read_csv(power)
        rivers = folder / "geoglows.csv"
        if rivers.exists():
            f = pd.read_csv(rivers)
        else:
            f = pd.DataFrame(columns=["date", *RIVER_COLUMNS])
        # left join: weather defines the days; no reach (sea) leaves discharge empty
        m = w.merge(f[["date", *RIVER_COLUMNS]], on="date", how="left")
        m.insert(0, "location_name", loc.name)
        m.insert(1, "lat", loc.lat)
        m.insert(2, "lon", loc.lon)
        m.insert(3, "cell_lat", loc.cell_lat)
        m.insert(4, "cell_lon", loc.cell_lon)
        frames.append(m)
    if not frames:
        sys.exit("merge: nothing to merge; run fetch_power.py first")
    out = pd.concat(frames, ignore_index=True)
    columns = ["location_name", "lat", "lon", "cell_lat", "cell_lon", "date",
               *WEATHER_COLUMNS, *RIVER_COLUMNS]
    out = (out[columns]
           .drop_duplicates(["location_name", "date"], keep="last")
           .sort_values(["location_name", "date"]))
    tmp = DATASET_FILE.with_suffix(".csv.tmp")
    out.to_csv(tmp, index=False)
    os.replace(tmp, DATASET_FILE)
    log.info("merge: wrote %s, %d rows, %d locations", DATASET_FILE, len(out), out.location_name.nunique())


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--merge", action="store_true", help="build weather_dataset.csv")
    p.add_argument("--force", action="store_true", help="re-fetch locations already saved")
    p.add_argument("--start", default=HISTORY_START)
    p.add_argument("--end", default=None, help="default: today - 7 days")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_FILE)])
    merge(args) if args.merge else run(args)


if __name__ == "__main__":
    main()
