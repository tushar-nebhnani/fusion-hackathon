"""Climate side of the cash-flow simulation: how often each hazard hits each
cell, and for how long (risk plan section 2).

    python ml/risk/hazard_params.py              # writes ml/data/hazard_params.csv
    python ml/risk/hazard_params.py --backtest   # fit 1995-2015, check 2016-2023
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import PoissonRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from assumptions import HAZARDS  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "data"
YEARS = (1995, 2023)  # IFI ends Sept 2023
TARGET_YEAR = 2026
BACKTEST_SPLIT = 2015
STORM_RADIUS_KM = 150

# Proposed event definitions. The temperature rules follow IMD's heatwave and
# cold-wave criteria as read on 2026-10-10; check them against IMD's glossary
IMD_VERY_HEAVY_MM = 115.6
FLASH_PERCENTILE = 0.995
# The percentile rule alone fires 1.8 times a year everywhere, deserts
# included, so it also needs IMD "heavy" rain
IMD_HEAVY_MM = 64.5
HEAT_TMAX_C = {"plains": 40.0, "coastal": 37.0, "hills": 30.0}
HEAT_SEVERE_C = 45.0
DEPARTURE_C = 4.5
COLD_TMIN_C = {"plains": 10.0, "coastal": 10.0, "hills": 0.0}
SPI_DRY = -1.0
NORMAL_SMOOTH_DAYS = 15

# Ridge penalty on the year trend: a single bad year must not become a trend
TREND_SHRINK = 1.0
# The current-year rate stays within this factor of the 29-year mean
TREND_CAP = 2.0
# IFI records jump in 2021-23 (reporting, not rivers), so no trend from them.
# The cold-wave trend lost to a constant rate in the backtest
NO_TREND = {"river_flood", "cold_wave"}
# A cell with fewer events borrows the hazard's mean duration
MIN_EVENTS_FOR_DURATION = 3


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    w = pd.read_csv(DATA / "weather_dataset.csv", parse_dates=["date"],
                    usecols=["location_name", "date", "precipitation_sum", "temperature_2m_max", "temperature_2m_min"])
    w = w[w.date.dt.year.between(*YEARS)].sort_values(["location_name", "date"]).reset_index(drop=True)
    spine = pd.read_csv(DATA / "spine.csv")
    floods = pd.read_csv(DATA / "events_flood.csv", parse_dates=["start_date", "end_date"])
    storms = pd.read_csv(DATA / "events_storm.csv", parse_dates=["date"])
    return w, spine, floods, storms


def merge_days(days: pd.DataFrame, hazard: str) -> pd.DataFrame:
    """(location_name, date) event days -> events: consecutive days become one."""
    d = days.drop_duplicates().sort_values(["location_name", "date"])
    new = d.groupby("location_name").date.diff().dt.days.ne(1)
    d = d.assign(event=new.cumsum())
    out = d.groupby(["location_name", "event"]).date.agg(start="min", duration="size").reset_index()
    return out.assign(hazard=hazard)[["location_name", "hazard", "start", "duration"]]


def weather_events(w: pd.DataFrame, spine: pd.DataFrame, floods: pd.DataFrame) -> pd.DataFrame:
    w = w.copy()
    doy = w.date.dt.dayofyear
    for col in ("temperature_2m_max", "temperature_2m_min"):
        clim = w.groupby(["location_name", doy])[col].mean()
        clim = clim.groupby(level=0).transform(lambda x: x.rolling(NORMAL_SMOOTH_DAYS, center=True, min_periods=1).mean())
        w[f"{col}_normal"] = pd.MultiIndex.from_arrays([w.location_name, doy]).map(clim)
    kind = np.where(spine.region == "north_hills", "hills", np.where(spine.coastal, "coastal", "plains"))
    threshold = w.location_name.map(dict(zip(spine.location_name, [HEAT_TMAX_C[k] for k in kind])))
    cold = w.location_name.map(dict(zip(spine.location_name, [COLD_TMIN_C[k] for k in kind])))
    p = w.groupby("location_name").precipitation_sum.transform(lambda x: x.quantile(FLASH_PERCENTILE))
    flags = {
        "flash_flood": (w.precipitation_sum >= IMD_VERY_HEAVY_MM)
                       | ((w.precipitation_sum >= p) & (w.precipitation_sum >= IMD_HEAVY_MM)),
        "heat": ((w.temperature_2m_max >= threshold)
                 & (w.temperature_2m_max - w.temperature_2m_max_normal >= DEPARTURE_C))
                | (w.temperature_2m_max >= HEAT_SEVERE_C),
        "cold_wave": (w.temperature_2m_min <= cold)
                     & (w.temperature_2m_min_normal - w.temperature_2m_min >= DEPARTURE_C),
    }
    # IFI does not split river from flash floods. A heavy-rain day inside a
    # recorded flood (or a day either side) is that flood, not a second event
    recorded = pd.MultiIndex.from_frame(flood_days(floods, pad=1))
    flags["flash_flood"] &= ~pd.MultiIndex.from_frame(w[["location_name", "date"]]).isin(recorded)
    return pd.concat([merge_days(w.loc[f, ["location_name", "date"]], h) for h, f in flags.items()])


def flood_days(floods: pd.DataFrame, pad: int = 0) -> pd.DataFrame:
    f = floods[floods.start_date.dt.year.between(*YEARS)]
    one = pd.Timedelta(days=pad)
    return pd.DataFrame(
        [(r.location_name, d) for r in f.itertuples() for d in pd.date_range(r.start_date - one, r.end_date + one)],
        columns=["location_name", "date"])


def flood_events(floods: pd.DataFrame) -> pd.DataFrame:
    return merge_days(flood_days(floods), "river_flood")


def storm_events(storms: pd.DataFrame) -> pd.DataFrame:
    s = storms[(storms.min_distance_km <= STORM_RADIUS_KM) & storms.date.dt.year.between(*YEARS)]
    return merge_days(s[["location_name", "date"]], "storm")


def spi3(w: pd.DataFrame) -> pd.DataFrame:
    """Standardised precipitation index of 3-month rain, gamma fit per cell
    and calendar month, with the share of zero totals as a point mass."""
    m = (w.set_index("date").groupby("location_name").precipitation_sum.resample("MS").sum()
         .groupby(level=0).rolling(3).sum().droplevel(0).dropna().rename("rain3").reset_index())
    out = []
    for _, g in m.groupby(["location_name", m.date.dt.month]):
        wet = g.rain3[g.rain3 > 0]
        if len(wet) < 5:
            out.append(g.assign(spi=np.nan))
            continue
        zero = 1 - len(wet) / len(g)
        shape, _, scale = stats.gamma.fit(wet, floc=0)
        cdf = zero + (1 - zero) * stats.gamma.cdf(g.rain3, shape, scale=scale)
        out.append(g.assign(spi=stats.norm.ppf(np.clip(cdf, 1e-4, 1 - 1e-4))))
    return pd.concat(out)


def drought_events(w: pd.DataFrame) -> pd.DataFrame:
    """One row per dry month (SPI-3 <= -1): drought is counted in months."""
    s = spi3(w)
    dry = s[s.spi <= SPI_DRY]
    return pd.DataFrame({"location_name": dry.location_name, "hazard": "drought", "start": dry.date, "duration": 1})


def all_events() -> tuple[pd.DataFrame, pd.DataFrame]:
    w, spine, floods, storms = load()
    events = pd.concat([flood_events(floods), weather_events(w, spine, floods), storm_events(storms), drought_events(w)],
                       ignore_index=True)
    return events, spine


def fit_rate(years: np.ndarray, counts: np.ndarray, at: np.ndarray, trend: bool) -> tuple[np.ndarray, float]:
    """Poisson rate with a shrunk year trend: log rate = a + b * (year - 2010) / 10."""
    mean = counts.mean()
    if mean == 0 or not trend:
        return np.full(len(at), mean), 0.0
    x = lambda y: ((np.asarray(y) - 2010) / 10).reshape(-1, 1)  # noqa: E731
    m = PoissonRegressor(alpha=TREND_SHRINK, max_iter=300).fit(x(years), counts)
    return np.clip(m.predict(x(at)), mean / TREND_CAP, mean * TREND_CAP), float(m.coef_[0])


def yearly_counts(events: pd.DataFrame, cells: list[str], first: int, last: int) -> pd.DataFrame:
    idx = pd.MultiIndex.from_product([cells, HAZARDS, range(first, last + 1)], names=["location_name", "hazard", "year"])
    c = events[events.start.dt.year.between(first, last)]
    return (c.groupby(["location_name", "hazard", c.start.dt.year.rename("year")]).size()
            .reindex(idx, fill_value=0).sort_index())


def build(events: pd.DataFrame, spine: pd.DataFrame) -> pd.DataFrame:
    counts = yearly_counts(events, list(spine.location_name), *YEARS)
    years = np.arange(YEARS[0], YEARS[1] + 1)
    hazard_duration = events.groupby("hazard").duration.mean()
    cell_duration = events.groupby(["location_name", "hazard"]).duration.agg(["mean", "size"])
    rows = []
    for (cell, hazard), c in counts.groupby(level=[0, 1]):
        rate, beta = fit_rate(years, c.values, np.array([TARGET_YEAR]), hazard not in NO_TREND)
        own = cell_duration.loc[(cell, hazard)] if (cell, hazard) in cell_duration.index else None
        measured = own is not None and own["size"] >= MIN_EVENTS_FOR_DURATION
        duration = own["mean"] if measured else hazard_duration.get(hazard, 1.0)
        rows.append({
            "location_name": cell, "hazard": hazard, "unit": "months" if hazard == "drought" else "days",
            "n_events": int(c.sum()), "events_per_year_mean": round(c.mean(), 4),
            "trend_per_decade": round(beta, 4), "events_per_year": round(float(rate[0]), 4),
            "mean_duration": round(float(duration), 2), "duration_from": "cell" if measured else "hazard average",
        })
    return pd.DataFrame(rows)


def backtest(events: pd.DataFrame, spine: pd.DataFrame) -> pd.DataFrame:
    """Fit on 1995-2015, predict yearly counts for 2016-2023, and compare the
    Poisson deviance of the trend model with a constant rate."""
    cells = list(spine.location_name)
    train = yearly_counts(events, cells, YEARS[0], BACKTEST_SPLIT)
    test = yearly_counts(events, cells, BACKTEST_SPLIT + 1, YEARS[1])
    fit_years = np.arange(YEARS[0], BACKTEST_SPLIT + 1)
    test_years = np.arange(BACKTEST_SPLIT + 1, YEARS[1] + 1)

    def deviance(y: np.ndarray, mu: np.ndarray) -> float:
        mu = np.maximum(mu, 1e-3)
        return float(2 * np.sum(np.where(y > 0, y * np.log(np.maximum(y, 1e-12) / mu), 0) - (y - mu)))

    rows = []
    for hazard in HAZARDS:
        d_trend = d_const = observed = predicted = 0.0
        for cell in cells:
            c, y = train.loc[(cell, hazard)].values, test.loc[(cell, hazard)].values
            mu, _ = fit_rate(fit_years, c, test_years, hazard not in NO_TREND)
            d_trend += deviance(y, mu)
            d_const += deviance(y, np.full(len(y), c.mean()))
            observed += y.sum()
            predicted += mu.sum()
        rows.append({"hazard": hazard, "observed_2016_23": int(observed), "predicted": round(predicted, 1),
                     "deviance_trend": round(d_trend, 1), "deviance_constant": round(d_const, 1)})
    return pd.DataFrame(rows)


if __name__ == "__main__":
    events, spine = all_events()
    if "--backtest" in sys.argv:
        print(backtest(events, spine).to_string(index=False))
    else:
        params = build(events, spine)
        params.to_csv(DATA / "hazard_params.csv", index=False)
        print(params.groupby("hazard")[["n_events", "events_per_year", "mean_duration"]].agg(
            {"n_events": "sum", "events_per_year": ["mean", "max"], "mean_duration": "mean"}).round(2).to_string())
        print(f"wrote {DATA / 'hazard_params.csv'}: {len(params)} rows")
