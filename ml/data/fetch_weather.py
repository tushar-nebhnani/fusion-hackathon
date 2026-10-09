"""Resumable 30-year daily weather + river discharge fetcher for the hazard
early-warning model. See README.md next to this file.

    python ml/data/fetch_weather.py              # full run (resumes)
    python ml/data/fetch_weather.py --dry-run    # one location, one year, prints only
    python ml/data/fetch_weather.py --retry-failed
    python ml/data/fetch_weather.py --merge
    python ml/data/fetch_weather.py --validate
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
LOCATIONS_FILE = HERE / "locations.json"
RAW_DIR = HERE / "raw"
PROGRESS_FILE = HERE / "progress.json"
LOG_FILE = HERE / "fetch.log"
DATASET_FILE = HERE / "weather_dataset.csv"

TIMEZONE = "Asia/Kolkata"
HISTORY_START = "1995-01-01"
# ERA5 lags real time by a few days
ERA5_LAG_DAYS = 7

# Same resolutions as CLIMATE.grid in api/src/config/climate.ts
GRID_HISTORICAL = 0.1
GRID_FLOOD = 0.05

APIS = {
    "archive": {
        "url": "https://archive-api.open-meteo.com/v1/archive",
        "variables": [
            "temperature_2m_max",
            "temperature_2m_min",
            "temperature_2m_mean",
            "apparent_temperature_max",
            "precipitation_sum",
            "rain_sum",
            "precipitation_hours",
            "wind_speed_10m_max",
            "wind_gusts_10m_max",
            "wind_direction_10m_dominant",
            "et0_fao_evapotranspiration",
            "relative_humidity_2m_mean",
            "pressure_msl_mean",
            "soil_moisture_0_to_7cm_mean",
        ],
    },
    # river_discharge_max is an ensemble statistic: Open-Meteo documents it
    # as forecast-only, so it is expected to be empty for historical dates
    "flood": {
        "url": "https://flood-api.open-meteo.com/v1/flood",
        "variables": ["river_discharge", "river_discharge_max"],
    },
}
FLOOD_COLUMNS = ["river_discharge", "river_discharge_max"]

# Free tier (open-meteo.com/en/pricing): 600/min, 5,000/hour, 10,000/day.
# Defaults leave headroom for the API dev server sharing the same IP.
DEFAULT_DELAY_S = 2.5
DEFAULT_HOURLY_BUDGET = 4000.0
DEFAULT_DAILY_BUDGET = 8000.0
MAX_ATTEMPTS = 6
TIMEOUT_S = 90
# Waits on a quota 429 do not use up attempts, but are capped so a chunk
# cannot wait forever
MAX_QUOTA_WAITS = 60

log = logging.getLogger("fetch_weather")


# ---------------------------------------------------------------- grid ----


def _decimals(resolution: float) -> int:
    return len(str(resolution).split(".")[1]) if "." in str(resolution) else 0


def snap(value: float, resolution: float) -> float:
    """Port of snap() in api/src/services/climate/grid.ts.

    JavaScript's Math.round rounds halves up (towards +inf); Python's round()
    rounds halves to even, so floor(x + 0.5) is used to match the live cells.
    """
    index = math.floor(value / resolution + 0.5)
    return round(index * resolution, _decimals(resolution))


def cell_id(lat: float, lon: float, resolution: float) -> str:
    d = _decimals(resolution)
    return f"{resolution}:{snap(lat, resolution):.{d}f}:{snap(lon, resolution):.{d}f}"


# ----------------------------------------------------------- locations ----


@dataclass
class Location:
    name: str
    lat: float
    lon: float
    sources: list[str]
    aliases: list[str] = field(default_factory=list)

    @property
    def cell_lat(self) -> float:
        return snap(self.lat, GRID_HISTORICAL)

    @property
    def cell_lon(self) -> float:
        return snap(self.lon, GRID_HISTORICAL)

    @property
    def flood_lat(self) -> float:
        return snap(self.lat, GRID_FLOOD)

    @property
    def flood_lon(self) -> float:
        return snap(self.lon, GRID_FLOOD)

    @property
    def cell(self) -> str:
        return cell_id(self.lat, self.lon, GRID_HISTORICAL)

    @property
    def slug(self) -> str:
        return re.sub(r"[^a-z0-9]+", "_", self.name.lower()).strip("_")


def load_locations() -> list[Location]:
    """One Location per 0.1 degree cell; the first entry's name wins and the
    others are kept as aliases."""
    entries = json.loads(LOCATIONS_FILE.read_text())
    by_cell: dict[str, Location] = {}
    for e in entries:
        loc = Location(e["name"], float(e["lat"]), float(e["lon"]), [e["source"]])
        kept = by_cell.get(loc.cell)
        if kept is None:
            by_cell[loc.cell] = loc
            continue
        if e["name"] != kept.name and e["name"] not in kept.aliases:
            kept.aliases.append(e["name"])
        if e["source"] not in kept.sources:
            kept.sources.append(e["source"])
    return list(by_cell.values())


# --------------------------------------------------------------- dates ----


def default_end_date() -> dt.date:
    return dt.date.today() - dt.timedelta(days=ERA5_LAG_DAYS)


def year_ranges(start: dt.date, end: dt.date) -> list[tuple[int, dt.date, dt.date]]:
    return [
        (y, max(start, dt.date(y, 1, 1)), min(end, dt.date(y, 12, 31)))
        for y in range(start.year, end.year + 1)
    ]


def request_weight(n_variables: int, n_days: int) -> float:
    """Open-Meteo's fractional call count: one call per 10 variables per 14 days."""
    return max(1.0, n_variables / 10) * max(1.0, n_days / 14)


# ------------------------------------------------------------ progress ----


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


class Progress:
    def __init__(self) -> None:
        data = json.loads(PROGRESS_FILE.read_text()) if PROGRESS_FILE.exists() else {}
        self.chunks: dict[str, dict] = data.get("chunks", {})
        self.variables: dict[str, list[str]] = data.get("variables", {})
        self.dropped: dict[str, list[str]] = data.get("dropped", {})
        # [unix_ts, weight] of recent requests, so a restart still honours
        # the hourly and daily budgets
        self.ledger: list[list[float]] = data.get("ledger", [])

    def save(self) -> None:
        cutoff = time.time() - 86400
        self.ledger = [e for e in self.ledger if e[0] >= cutoff]
        atomic_write(
            PROGRESS_FILE,
            json.dumps(
                {
                    "chunks": self.chunks,
                    "variables": self.variables,
                    "dropped": self.dropped,
                    "ledger": self.ledger,
                },
                indent=1,
            ),
        )

    def is_done(self, chunk: str, path: Path) -> bool:
        return self.chunks.get(chunk, {}).get("status") == "done" and path.exists()


# ------------------------------------------------------------- throttle ----


class Throttle:
    def __init__(self, progress: Progress, delay: float, hourly: float, daily: float) -> None:
        self.progress = progress
        self.delay = delay
        self.hourly = hourly
        self.daily = daily
        self.last = 0.0

    def _used(self, window: float, now: float) -> float:
        return sum(w for ts, w in self.progress.ledger if ts >= now - window)

    def _wait_for(self, window: float, budget: float, weight: float, now: float) -> float:
        """Seconds until enough of the window's weight has expired."""
        entries = sorted(e for e in self.progress.ledger if e[0] >= now - window)
        excess = sum(w for _, w in entries) + weight - budget
        if excess <= 0:
            return 0.0
        for ts, w in entries:
            excess -= w
            if excess <= 0:
                return ts + window - now + 1
        return window

    def acquire(self, weight: float) -> None:
        while True:
            now = time.time()
            wait = max(
                self.last + self.delay - now,
                self._wait_for(3600, self.hourly, weight, now),
                self._wait_for(86400, self.daily, weight, now),
            )
            if wait <= 0:
                break
            if wait > 30:
                log.info(
                    "budget wait %.0f min (used %.0f/h, %.0f/day)",
                    wait / 60,
                    self._used(3600, now),
                    self._used(86400, now),
                )
                # persist the ledger before a long sleep in case we are killed
                self.progress.save()
            time.sleep(wait)
        self.last = time.time()
        self.progress.ledger.append([self.last, weight])

    def rate_per_second(self, avg_weight: float) -> float:
        return min(avg_weight / self.delay, self.hourly / 3600, self.daily / 86400)


# ---------------------------------------------------------------- http ----


class ChunkFailed(Exception):
    pass


class NoData(Exception):
    """The upstream has no grid point here (e.g. GloFAS over the sea)."""


session = requests.Session()
session.headers["User-Agent"] = "ClimaCredit-ml-dataset/1.0"


def get_json(api: str, params: dict, throttle: Throttle | None, weight: float) -> dict:
    url = APIS[api]["url"]
    attempts = 0
    quota_waits = 0
    while True:
        if throttle:
            throttle.acquire(weight)
        attempts += 1
        try:
            r = session.get(url, params=params, timeout=TIMEOUT_S)
        except requests.RequestException as exc:
            reason = f"{type(exc).__name__}: {exc}"
            status = None
        else:
            if r.status_code == 200:
                return r.json()
            status = r.status_code
            try:
                reason = r.json().get("reason", r.text[:200])
            except ValueError:
                reason = r.text[:200]
            if status == 400:
                if re.search(r"no data|not available|outside", reason, re.I):
                    raise NoData(reason)
                raise ChunkFailed(f"400: {reason}")
            if status == 429 and re.search(r"minutely|hourly|daily", reason, re.I):
                quota_waits += 1
                attempts -= 1
                if quota_waits > MAX_QUOTA_WAITS:
                    raise ChunkFailed(f"429 quota, gave up after {MAX_QUOTA_WAITS} waits: {reason}")
                if re.search("daily", reason, re.I):
                    pause = 3600
                elif re.search("hourly", reason, re.I):
                    pause = 600
                else:
                    pause = 65
                log.warning("%s 429 quota (%s); sleeping %d min", api, reason, pause // 60)
                time.sleep(pause)
                continue
            if status != 429 and status < 500:
                raise ChunkFailed(f"{status}: {reason}")
        if attempts >= MAX_ATTEMPTS:
            raise ChunkFailed(f"after {attempts} attempts: {status} {reason}")
        backoff = min(300, 2 ** attempts * 2) * random.uniform(0.7, 1.3)
        log.warning("%s retry %d/%d in %.0fs: %s %s", api, attempts, MAX_ATTEMPTS, backoff, status, reason)
        time.sleep(backoff)


def base_params(api: str, loc: Location, start: dt.date, end: dt.date, variables: list[str]) -> dict:
    lat, lon = (loc.flood_lat, loc.flood_lon) if api == "flood" else (loc.cell_lat, loc.cell_lon)
    return {
        "latitude": lat,
        "longitude": lon,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": ",".join(variables),
        "timezone": TIMEZONE,
    }


def probe_variables(api: str, loc: Location, progress: Progress) -> list[str]:
    """Asks for a few days with every wanted variable; drops any the API
    rejects. Cached in progress.json so a resume does not re-probe."""
    if api in progress.variables:
        return progress.variables[api]
    variables = list(APIS[api]["variables"])
    dropped: list[str] = []
    day = dt.date(2020, 1, 1)
    while variables:
        params = base_params(api, loc, day, day + dt.timedelta(days=2), variables)
        try:
            get_json(api, params, None, 1)
            break
        except ChunkFailed as exc:
            m = re.search(r"invalid String value ([A-Za-z0-9_]+)", str(exc))
            if not m or m.group(1) not in variables:
                raise
            variables.remove(m.group(1))
            dropped.append(m.group(1))
            log.warning("%s: variable %s is not supported, dropped", api, m.group(1))
        except NoData:
            # probe point has no data; trust the list and let chunks decide
            break
    progress.variables[api] = variables
    progress.dropped[api] = dropped
    progress.save()
    return variables


def fetch_chunk(api: str, loc: Location, start: dt.date, end: dt.date,
                variables: list[str], throttle: Throttle | None) -> pd.DataFrame:
    days = (end - start).days + 1
    params = base_params(api, loc, start, end, variables)
    try:
        payload = get_json(api, params, throttle, request_weight(len(variables), days))
        daily = payload.get("daily") or {}
        frame = pd.DataFrame({"date": daily.get("time", [])})
        for v in variables:
            frame[v] = daily.get(v, [None] * len(frame))
    except NoData:
        frame = pd.DataFrame({"date": pd.date_range(start, end).strftime("%Y-%m-%d")})
        for v in variables:
            frame[v] = None
    return frame


# ---------------------------------------------------------------- plan ----


@dataclass
class Chunk:
    loc: Location
    api: str
    year: int
    start: dt.date
    end: dt.date

    @property
    def key(self) -> str:
        return f"{self.loc.slug}/{self.api}_{self.year}"

    @property
    def path(self) -> Path:
        return RAW_DIR / self.loc.slug / f"{self.api}_{self.year}.csv"


def plan(locations: list[Location], start: dt.date, end: dt.date,
         apis: tuple[str, ...] = ("archive", "flood")) -> list[Chunk]:
    return [
        Chunk(loc, api, y, s, e)
        for loc in locations
        for y, s, e in year_ranges(start, end)
        for api in apis
    ]


def chunk_weight(c: Chunk, variables: dict[str, list[str]]) -> float:
    n = len(variables.get(c.api, APIS[c.api]["variables"]))
    return request_weight(n, (c.end - c.start).days + 1)


def fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    return f"{d}d {h}h {m}m" if d else f"{h}h {m}m"


# ----------------------------------------------------------------- run ----


def run(args: argparse.Namespace, retry_failed: bool) -> None:
    start = dt.date.fromisoformat(args.start)
    end = dt.date.fromisoformat(args.end) if args.end else default_end_date()
    locations = load_locations()
    progress = Progress()
    throttle = Throttle(progress, args.delay, args.hourly_budget, args.daily_budget)

    apis = tuple(args.apis.split(","))
    for api in apis:
        probe_variables(api, locations[0], progress)

    chunks = plan(locations, start, end, apis)
    if retry_failed:
        todo = [c for c in chunks if progress.chunks.get(c.key, {}).get("status") == "failed"]
    else:
        todo = [c for c in chunks if not progress.is_done(c.key, c.path)]

    total_weight = sum(chunk_weight(c, progress.variables) for c in todo)
    avg_weight = total_weight / len(todo) if todo else 1
    rate = throttle.rate_per_second(avg_weight)
    log.info(
        "plan: %d locations (cells), %s..%s, %d requests total, %d to do "
        "(~%.0f weighted Open-Meteo calls); budget %.0f/h, %.0f/day, delay %.1fs; "
        "estimated duration %s",
        len(locations), start, end, len(chunks), len(todo), total_weight,
        args.hourly_budget, args.daily_budget, args.delay,
        fmt_duration(total_weight / rate if todo else 0),
    )
    for api, dropped in progress.dropped.items():
        if dropped:
            log.warning("%s: dropped unsupported variables %s", api, dropped)

    slugs = [loc.slug for loc in locations]
    remaining = total_weight
    began = time.time()
    done_weight = 0.0
    failed = 0
    for i, c in enumerate(todo, 1):
        w = chunk_weight(c, progress.variables)
        try:
            frame = fetch_chunk(c.api, c.loc, c.start, c.end, progress.variables[c.api], throttle)
        except ChunkFailed as exc:
            failed += 1
            prev = progress.chunks.get(c.key, {})
            progress.chunks[c.key] = {"status": "failed", "error": str(exc),
                                      "tries": prev.get("tries", 0) + 1}
            log.error("FAILED %s: %s", c.key, exc)
        else:
            atomic_write(c.path, frame.to_csv(index=False))
            empty = bool(frame.drop(columns="date").isna().all(axis=None))
            progress.chunks[c.key] = {"status": "done", "rows": len(frame),
                                      **({"empty": True} if empty else {})}
        progress.save()
        remaining -= w
        done_weight += w
        elapsed = time.time() - began
        observed = done_weight / elapsed if elapsed > 0 else rate
        eta = remaining / min(observed, rate) if remaining > 0 else 0
        log.info(
            "location %d/%d %s, year %d, %s | chunk %d/%d | failed %d | ETA %s",
            slugs.index(c.loc.slug) + 1, len(locations), c.loc.name, c.year, c.api,
            i, len(todo), failed, fmt_duration(eta),
        )
    log.info("finished: %d chunks attempted, %d failed. Run --retry-failed for those, then --merge.",
             len(todo), failed)


def dry_run(args: argparse.Namespace) -> None:
    locations = load_locations()
    loc = next((x for x in locations if x.name == args.location), locations[0])
    year = args.year
    start, end = dt.date(year, 1, 1), min(dt.date(year, 12, 31), default_end_date())
    # probe results only; dry runs never touch progress.json or raw/
    progress = Progress()
    progress.save = lambda: None  # type: ignore[method-assign]
    print(f"location {loc.name}: raw {loc.lat},{loc.lon} -> cell {loc.cell_lat},{loc.cell_lon}"
          f" (flood {loc.flood_lat},{loc.flood_lon}), aliases {loc.aliases}")
    print(f"{len(locations)} unique cells after de-duplication")
    for api in APIS:
        variables = probe_variables(api, loc, progress)
        w = request_weight(len(variables), (end - start).days + 1)
        print(f"\n== {api} {year}: {len(variables)} variables, weight {w:.1f} calls"
              f"; dropped {progress.dropped.get(api) or 'none'}")
        frame = fetch_chunk(api, loc, start, end, variables, None)
        nan = frame.isna().sum()
        with pd.option_context("display.width", 250, "display.max_columns", 30):
            print(frame.head(5).to_string(index=False))
        print(f"... {len(frame)} rows, NaN per column: {nan[nan > 0].to_dict() or 'none'}")


# --------------------------------------------------------------- merge ----


def merge(args: argparse.Namespace) -> None:
    locations = load_locations()
    progress = Progress()
    weather_vars = progress.variables.get("archive", APIS["archive"]["variables"])
    frames = []
    for loc in locations:
        folder = RAW_DIR / loc.slug
        archive = sorted(folder.glob("archive_*.csv"))
        flood = sorted(folder.glob("flood_*.csv"))
        if not archive:
            log.warning("merge: no archive chunks for %s, skipped", loc.name)
            continue
        w = pd.concat([pd.read_csv(p) for p in archive]).drop_duplicates("date", keep="last")
        if flood:
            f = pd.concat([pd.read_csv(p) for p in flood]).drop_duplicates("date", keep="last")
        else:
            f = pd.DataFrame(columns=["date", *FLOOD_COLUMNS])
        for col in FLOOD_COLUMNS:
            if col not in f:
                f[col] = None
        m = w.merge(f[["date", *FLOOD_COLUMNS]], on="date", how="outer")
        m.insert(0, "location_name", loc.name)
        m.insert(1, "lat", loc.lat)
        m.insert(2, "lon", loc.lon)
        m.insert(3, "cell_lat", loc.cell_lat)
        m.insert(4, "cell_lon", loc.cell_lon)
        frames.append(m)
    if not frames:
        sys.exit("merge: no raw chunks found; run the fetch first")
    out = pd.concat(frames, ignore_index=True)
    columns = ["location_name", "lat", "lon", "cell_lat", "cell_lon", "date",
               *[v for v in weather_vars if v in out], *FLOOD_COLUMNS]
    out = (out[columns]
           .drop_duplicates(["location_name", "date"], keep="last")
           .sort_values(["location_name", "date"]))
    tmp = DATASET_FILE.with_suffix(".csv.tmp")
    out.to_csv(tmp, index=False)
    os.replace(tmp, DATASET_FILE)
    log.info("merge: wrote %s, %d rows, %d locations", DATASET_FILE, len(out), out.location_name.nunique())


# ------------------------------------------------------------ validate ----

RANGES = {
    "temperature_2m_max": (-30, 55), "temperature_2m_min": (-30, 55),
    "temperature_2m_mean": (-30, 55), "apparent_temperature_max": (-30, 55),
    "precipitation_sum": (0, None), "rain_sum": (0, None), "precipitation_hours": (0, 24),
    "river_discharge": (0, None), "river_discharge_max": (0, None), "river_discharge_local": (0, None),
}


def validate(args: argparse.Namespace) -> None:
    if not DATASET_FILE.exists():
        sys.exit("validate: run --merge first")
    start = pd.Timestamp(args.start)
    end = pd.Timestamp(args.end) if args.end else pd.Timestamp(default_end_date())
    df = pd.read_csv(DATASET_FILE)
    expected = pd.date_range(start, end)
    print(f"file {DATASET_FILE} ({DATASET_FILE.stat().st_size / 1e6:.1f} MB)")
    print(f"rows {len(df):,}, locations {df.location_name.nunique()}, "
          f"dates {df.date.min()} .. {df.date.max()} (expected {start.date()} .. {end.date()})")

    print("\n-- coverage (missing dates / duplicate rows)")
    for name, g in df.groupby("location_name"):
        dates = pd.to_datetime(g.date)
        missing = expected.difference(dates)
        dups = int(g.duplicated(["date"]).sum())
        flag = "" if len(missing) == 0 and dups == 0 else "  <--"
        print(f"{name:22s} rows {len(g):6d} missing {len(missing):5d} duplicates {dups}{flag}")
        if 0 < len(missing) <= 10:
            print("    missing:", ", ".join(d.strftime("%Y-%m-%d") for d in missing))

    print("\n-- NaN count per column per location (columns with any NaN)")
    value_cols = [c for c in df.columns if c not in
                  ("location_name", "lat", "lon", "cell_lat", "cell_lon", "date")]
    nan = df.groupby("location_name")[value_cols].apply(lambda g: g.isna().sum())
    nan = nan.loc[:, (nan > 0).any()]
    print(nan.to_string() if not nan.empty else "none")

    print("\n-- sanity ranges (flagged, not deleted)")
    any_flag = False
    for col, (lo, hi) in RANGES.items():
        if col not in df:
            continue
        s = df[col]
        bad = (s < lo) if lo is not None else pd.Series(False, index=s.index)
        if hi is not None:
            bad |= s > hi
        n = int(bad.sum())
        if n:
            any_flag = True
            sample = df.loc[bad, ["location_name", "date", col]].head(5).to_string(index=False)
            print(f"{col}: {n} outside [{lo}, {hi}]\n{sample}")
    if not any_flag:
        print("all values within range")


# ---------------------------------------------------------------- main ----


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="one location, one year; prints only")
    mode.add_argument("--retry-failed", action="store_true", help="re-attempt chunks marked failed")
    mode.add_argument("--merge", action="store_true", help="combine raw chunks into weather_dataset.csv")
    mode.add_argument("--validate", action="store_true", help="print a report on weather_dataset.csv")
    p.add_argument("--start", default=HISTORY_START)
    p.add_argument("--end", default=None, help="default: today - 7 days")
    p.add_argument("--delay", type=float, default=DEFAULT_DELAY_S, help="minimum seconds between requests")
    p.add_argument("--hourly-budget", type=float, default=DEFAULT_HOURLY_BUDGET,
                   help="weighted Open-Meteo calls per rolling hour")
    p.add_argument("--daily-budget", type=float, default=DEFAULT_DAILY_BUDGET,
                   help="weighted Open-Meteo calls per rolling 24 h")
    p.add_argument("--apis", default="archive,flood", choices=["archive,flood", "archive", "flood"],
                   help="which upstreams to fetch (default both)")
    p.add_argument("--location", default=None, help="--dry-run: location name (default: first)")
    p.add_argument("--year", type=int, default=2024, help="--dry-run: year (default 2024)")
    args = p.parse_args()

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if not args.dry_run:
        handlers.append(logging.FileHandler(LOG_FILE))
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s")

    if args.dry_run:
        dry_run(args)
    elif args.merge:
        merge(args)
    elif args.validate:
        validate(args)
    else:
        run(args, retry_failed=args.retry_failed)


if __name__ == "__main__":
    main()
