"""Model 4 hindcast: replay alert tripwires on observed weather, collapse
firing days into episodes, label each against real events (plan section 4).

Features use only data up to an episode's first day. The label looks ahead
(episode start - 1 day to episode end + LABEL_AFTER_DAYS).

    python ml/features/alerts.py   # writes ml/data/features_flood.csv, features_storm.csv
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from spine import DATA

TRAIN_YEARS = (1995, 2015)
VAL_YEARS = (2016, 2019)
TEST_YEARS = (2020, 2023)
LABEL_BEFORE_DAYS = 1
LABEL_AFTER_DAYS = 3
# Live monitor's IMD heavy-rain class (CLIMATE.monitor.rain.heavyMm)
IMD_HEAVY_MM = 64.5
# Relative tripwires: EDA showed IMD 64.5 mm catches 20% of floods on this
# 0.5 deg data, a cell's own p95 of 3-day rain 55%
REL_RAIN3_PCT = 0.95
REL_PCT = 0.99
STORM_RADIUS_KM = 150
# Guwahati and Dispur share one NASA POWER grid box; keep one
DROP_CELLS = {"Dispur"}

FLOOD_FEATURES = [
    "rain", "rain_over_p99", "rain3", "rain3_over_p95", "rain7", "rain14", "wet_days7",
    "rain30_anom", "soil", "soil_anom", "rh", "doy_sin", "doy_cos", "monsoon",
    "coastal", "cell_flood_rate", "trip_imd", "trip_rel",
]
STORM_FEATURES = [
    "rain", "rain_over_p99", "rain3", "wind", "wind_over_p99", "pressure_anom", "rh",
    "doy_sin", "doy_cos", "post_monsoon", "trip_wind", "trip_rain",
]


def _in(years: tuple[int, int], dates: pd.Series) -> pd.Series:
    return dates.dt.year.between(*years)


def daily_features(weather: pd.DataFrame, spine: pd.DataFrame, floods: pd.DataFrame) -> pd.DataFrame:
    w = weather[~weather.location_name.isin(DROP_CELLS)].copy()
    w["date"] = pd.to_datetime(w.date)
    w = w.sort_values(["location_name", "date"]).reset_index(drop=True)
    g = w.groupby("location_name")
    w["rain"] = w.precipitation_sum
    w["rain3"] = g.rain.transform(lambda x: x.rolling(3, 1).sum())
    w["rain7"] = g.rain.transform(lambda x: x.rolling(7, 1).sum())
    w["rain14"] = g.rain.transform(lambda x: x.rolling(14, 1).sum())
    w["rain30"] = g.rain.transform(lambda x: x.rolling(30, 1).sum())
    w["wet_days7"] = g.rain.transform(lambda x: (x >= 10).rolling(7, 1).sum())
    w["soil"] = w.soil_wetness_top
    w["wind"] = w.wind_speed_10m_max
    w["rh"] = w.relative_humidity_2m_mean
    w["month"] = w.date.dt.month
    doy = w.date.dt.dayofyear
    w["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    w["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    w["monsoon"] = w.month.between(6, 9).astype(int)
    w["post_monsoon"] = w.month.between(10, 12).astype(int)

    # Thresholds and climatology from training years only
    train = w[_in(TRAIN_YEARS, w.date)]
    q = train.groupby("location_name").agg(
        rain_p99=("rain", lambda x: x.quantile(REL_PCT)),
        rain3_p95=("rain3", lambda x: x.quantile(REL_RAIN3_PCT)),
        wind_p99=("wind", lambda x: x.quantile(REL_PCT)),
    )
    clim = train.groupby(["location_name", "month"]).agg(
        rain30_clim=("rain30", "mean"), soil_clim=("soil", "mean"),
        pressure_clim=("surface_pressure_mean", "mean"),
    )
    w = w.join(q, on="location_name").join(clim, on=["location_name", "month"])
    w["rain_over_p99"] = w.rain / w.rain_p99
    w["rain3_over_p95"] = w.rain3 / w.rain3_p95
    w["wind_over_p99"] = w.wind / w.wind_p99
    w["rain30_anom"] = w.rain30 - w.rain30_clim
    w["soil_anom"] = w.soil - w.soil_clim
    w["pressure_anom"] = w.surface_pressure_mean - w.pressure_clim

    years = TRAIN_YEARS[1] - TRAIN_YEARS[0] + 1
    f = pd.to_datetime(floods.start_date)
    rate = floods[_in(TRAIN_YEARS, f)].groupby("location_name").size() / years
    w["cell_flood_rate"] = w.location_name.map(rate).fillna(0.0)
    w = w.merge(spine[["location_name", "coastal", "region"]], on="location_name")
    w["coastal"] = w.coastal.astype(int)

    w["trip_imd"] = (w.rain >= IMD_HEAVY_MM).astype(int)
    w["trip_rel"] = (w.rain3 >= w.rain3_p95).astype(int)
    w["trip_wind"] = (w.wind >= w.wind_p99).astype(int)
    w["trip_rain"] = (w.rain >= w.rain_p99).astype(int)
    return w


def episodes(w: pd.DataFrame, fired: pd.Series) -> pd.DataFrame:
    """Consecutive firing days in a cell become one episode; the row kept is
    the first day, with the episode's last day in `end`."""
    w = w.assign(fired=fired.astype(bool))
    prev = w.groupby("location_name").fired.shift(fill_value=False)
    w["episode"] = (w.fired & ~prev).groupby(w.location_name).cumsum()
    on = w[w.fired]
    ends = on.groupby(["location_name", "episode"]).date.max().rename("end")
    first = on.groupby(["location_name", "episode"]).head(1)
    return first.join(ends, on=["location_name", "episode"]).rename(columns={"date": "start"})


def label(eps: pd.DataFrame, event_dates: pd.DataFrame) -> pd.Series:
    """1 when an event for the cell falls in [start - before, end + after]."""
    by_cell = {k: np.sort(v.values) for k, v in event_dates.groupby("location_name").date}
    hits = []
    for e in eps.itertuples():
        dates = by_cell.get(e.location_name)
        if dates is None:
            hits.append(0)
            continue
        lo = np.datetime64(e.start - pd.Timedelta(days=LABEL_BEFORE_DAYS))
        hi = np.datetime64(e.end + pd.Timedelta(days=LABEL_AFTER_DAYS))
        i = np.searchsorted(dates, lo)
        hits.append(int(i < len(dates) and dates[i] <= hi))
    return pd.Series(hits, index=eps.index)


def misses(eps: pd.DataFrame, event_dates: pd.DataFrame) -> pd.DataFrame:
    """Events with no episode covering them: what the tripwires never fired for."""
    out = []
    for e in event_dates.itertuples():
        c = eps[eps.location_name == e.location_name]
        covered = ((c.start - pd.Timedelta(days=LABEL_BEFORE_DAYS) <= e.date)
                   & (e.date <= c.end + pd.Timedelta(days=LABEL_AFTER_DAYS))).any()
        out.append(not covered)
    return event_dates[np.array(out, dtype=bool)]


def flood_dataset(w: pd.DataFrame, floods: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    eps = episodes(w, (w.trip_imd == 1) | (w.trip_rel == 1))
    ev = floods.assign(date=pd.to_datetime(floods.start_date))[["location_name", "date"]]
    ev = ev[~ev.location_name.isin(DROP_CELLS) & ev.date.dt.year.between(TRAIN_YEARS[0], TEST_YEARS[1])]
    eps["label"] = label(eps, ev)
    return eps, misses(eps, ev)


def storm_dataset(w: pd.DataFrame, storms: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    s = storms[storms.min_distance_km <= STORM_RADIUS_KM]
    s = s.assign(date=pd.to_datetime(s.date))[["location_name", "date"]]
    s = s[~s.location_name.isin(DROP_CELLS)]
    # Storm calibration only where storms happen (plan section 3.3)
    cells = set(storms.location_name)
    ws = w[w.location_name.isin(cells)]
    eps = episodes(ws, (ws.trip_wind == 1) | (ws.trip_rain == 1))
    eps["label"] = label(eps, s)
    return eps, misses(eps, s)


def split(eps: pd.DataFrame) -> dict[str, pd.DataFrame]:
    return {name: eps[_in(years, eps.start)]
            for name, years in (("train", TRAIN_YEARS), ("val", VAL_YEARS), ("test", TEST_YEARS))}


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    weather = pd.read_csv(DATA / "weather_dataset.csv")
    spine = pd.read_csv(DATA / "spine.csv")
    floods = pd.read_csv(DATA / "events_flood.csv")
    storms = pd.read_csv(DATA / "events_storm.csv")
    return weather, spine, floods, storms


def write(eps: pd.DataFrame, features: list[str], name: str) -> None:
    out = eps[["location_name", "region", "start", "end", *features, "label"]].copy()
    out.insert(4, "split", "none")
    for part, years in (("train", TRAIN_YEARS), ("val", VAL_YEARS), ("test", TEST_YEARS)):
        out.loc[_in(years, out.start), "split"] = part
    out = out[out.split != "none"]
    out.to_csv(DATA / f"features_{name}.csv", index=False, float_format="%.4f")
    print(f"{name}: {len(out)} episodes, positive rate {out.label.mean():.3f}, "
          f"{out.split.value_counts().to_dict()}")


if __name__ == "__main__":
    # Writes the model-ready tables; training lives with the backend engineer
    weather, spine, floods, storms = load()
    w = daily_features(weather, spine, floods)
    flood_eps, _ = flood_dataset(w, floods)
    storm_eps, _ = storm_dataset(w, storms)
    write(flood_eps, FLOOD_FEATURES, "flood")
    write(storm_eps, STORM_FEATURES, "storm")
