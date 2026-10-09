"""River discharge from GEOGLOWS v2 (ECMWF; free, no key, daily 1940-present,
one request per river reach). Replaces the Open-Meteo flood fetch for the
hackathon. See README.md.

    python ml/data/fetch_geoglows.py           # every location (skips ones already saved)
    python ml/data/fetch_power.py --merge      # picks up raw/*/geoglows.csv
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests

from fetch_weather import HISTORY_START, LOG_FILE, RAW_DIR, atomic_write, load_locations

API = "https://geoglows.ecmwf.int/api/v2"
# The reach under a point is often a small side stream, so the ring around it
# is searched too and the reach with the largest mean flow is kept (~5.5 km)
RING_DEG = 0.05
WORKERS = 6
MAX_ATTEMPTS = 5

log = logging.getLogger("fetch_geoglows")
session = requests.Session()
session.headers["User-Agent"] = "ClimaCredit-ml-dataset/1.0"


def get(url: str, timeout: int) -> requests.Response:
    reason = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            r = session.get(url, timeout=timeout)
            if r.status_code == 200:
                return r
            reason = f"{r.status_code}: {r.text[:200]}"
            if r.status_code < 500 and r.status_code != 429:
                break
        except requests.RequestException as exc:
            reason = f"{type(exc).__name__}: {exc}"
        time.sleep(min(60, 2 ** attempt * 2) * random.uniform(0.7, 1.3))
    raise RuntimeError(reason)


def river_id(lat: float, lon: float) -> int | None:
    try:
        return int(get(f"{API}/getriverid?lat={lat:.4f}&lon={lon:.4f}", 60).json()["river_id"])
    except (RuntimeError, KeyError, ValueError, TypeError):
        # over the sea or outside the network
        return None


def discharge(rid: int) -> pd.Series:
    r = get(f"{API}/retrospectivedaily/{rid}?format=csv", 180)
    df = pd.read_csv(io.StringIO(r.text))
    s = pd.Series(df.iloc[:, 1].values, index=df.iloc[:, 0].str[:10], name=str(rid))
    s.index.name = "date"
    return s


def ring(lat: float, lon: float) -> list[tuple[float, float]]:
    d = RING_DEG
    return [(lat + a * d, lon + b * d) for a in (0, -1, 1) for b in (0, -1, 1)]


def fetch_location(loc, start: str, pool: ThreadPoolExecutor) -> str:
    ids = list(pool.map(lambda p: river_id(*p), ring(loc.lat, loc.lon)))
    nearest = ids[0]
    unique = [i for i in dict.fromkeys(ids) if i is not None]
    if not unique:
        return "no river reach (sea)"
    series = dict(zip(unique, pool.map(discharge, unique)))
    means = {rid: float(s.mean()) for rid, s in series.items()}
    main = max(means, key=lambda k: means[k])
    out = pd.DataFrame({"river_discharge": series[main]})
    out["river_discharge_local"] = series[nearest] if nearest in series else None
    out = out[out.index >= start].round(3).reset_index()
    folder = RAW_DIR / loc.slug
    atomic_write(folder / "geoglows.csv", out.to_csv(index=False))
    atomic_write(folder / "geoglows.json", json.dumps(
        {"main_river_id": main, "nearest_river_id": nearest,
         "mean_m3s": {str(k): round(v, 2) for k, v in means.items()}}, indent=1))
    return f"main reach {main} (mean {means[main]:.1f} m3/s), nearest {nearest}, {len(out)} days"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--force", action="store_true", help="re-fetch locations already saved")
    p.add_argument("--start", default=HISTORY_START)
    p.add_argument("--location", default=None, help="only this location")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_FILE)])
    locations = [x for x in load_locations() if args.location in (None, x.name)]
    failed = []
    with ThreadPoolExecutor(WORKERS) as pool:
        for i, loc in enumerate(locations, 1):
            if (RAW_DIR / loc.slug / "geoglows.csv").exists() and not args.force:
                log.info("geoglows %d/%d %s: already saved, skipped", i, len(locations), loc.name)
                continue
            try:
                msg = fetch_location(loc, args.start, pool)
            except RuntimeError as exc:
                failed.append(loc.name)
                msg = f"FAILED: {exc}"
            log.info("geoglows %d/%d %s: %s", i, len(locations), loc.name, msg)
    log.info("geoglows: done, %d failed %s. Re-run to retry them.", len(failed), failed or "")


if __name__ == "__main__":
    main()
