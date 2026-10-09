"""Synthetic monthly revenue for model 6 (plan section 6.2).

EVERY SERIES IS SYNTHETIC. Shocks are placed on real flood and storm dates
for the business's cell, plus business-only shocks with no weather cause.
Because we place every shock, we can measure the detector.

    python ml/features/build_monthly.py          # prints a summary
    python ml/features/build_monthly.py --write  # also writes ml/data/synthetic_monthly.csv
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ML = Path(__file__).resolve().parents[1]
DATA = ML / "data"
sys.path.insert(0, str(ML))
from risk.assumptions import season  # noqa: E402

SEED = 11
FIRST, LAST = "2015-01", "2023-12"
PER_CELL = 30
STORM_RADIUS_KM = 150
# ASSUMED. Revenue drop in the event month at sensitivity 1. Chennai 2015
# informs which sectors lose most, not these sizes
EVENT_DROP = {"flood": 0.6, "storm": 0.5}
RECOVERY_MONTHS = (2, 6)
# ASSUMED. A business-only shock (lost customer, illness): chance per month, size, recovery
IDIO_RATE = 0.006
IDIO_DROP = (0.30, 0.60)
IDIO_RECOVERY_MONTHS = (3, 8)
# Somanathan et al.: about 2% output per degree C. Applied above a 1 C monthly anomaly
HEAT_LOSS_PER_C = 0.02
HEAT_ANOMALY_C = 1.0
# ASSUMED
GROWTH = (0.03, 0.05)
NOISE = (0.05, 0.15)
EMI_SHARE = 0.08
LATE_BASE = 0.03
LATE_PER_DROP = 0.5
# A drop this deep counts as a shock when scoring the detector
SHOCK_DROP = 0.15


def event_months(months: pd.PeriodIndex) -> pd.DataFrame:
    """cells x months: flood sensitivity key hit this month (river and flash
    together, because IFI does not split them) and storm."""
    floods = pd.read_csv(DATA / "events_flood.csv", parse_dates=["start_date"])
    storms = pd.read_csv(DATA / "events_storm.csv", parse_dates=["date"])
    storms = storms[storms.min_distance_km <= STORM_RADIUS_KM]
    f = floods.assign(month=floods.start_date.dt.to_period("M"), kind="flood")[["location_name", "month", "kind"]]
    s = storms.assign(month=storms.date.dt.to_period("M"), kind="storm")[["location_name", "month", "kind"]]
    e = pd.concat([f, s]).drop_duplicates()
    return e[e.month.isin(months)]


def heat_anomaly(months: pd.PeriodIndex) -> pd.DataFrame:
    w = pd.read_csv(DATA / "weather_dataset.csv", usecols=["location_name", "date", "temperature_2m_max"], parse_dates=["date"])
    m = w.groupby(["location_name", w.date.dt.to_period("M").rename("month")]).temperature_2m_max.mean().reset_index()
    normal = m[m.month.dt.year < months[0].year].groupby(["location_name", m.month.dt.month.rename("m")]).temperature_2m_max.mean()
    m["anomaly"] = m.temperature_2m_max - pd.MultiIndex.from_arrays([m.location_name, m.month.dt.month]).map(normal)
    return m[m.month.isin(months)].pivot(index="month", columns="location_name", values="anomaly")


def recovery(drop: np.ndarray, onset: np.ndarray, months: np.ndarray) -> np.ndarray:
    """A drop at each onset fading geometrically to 10% over `months`. Arrays are time x business."""
    out = np.zeros(drop.shape)
    for t, b in zip(*np.nonzero(onset)):
        k = np.arange(drop.shape[0] - t)
        fade = 0.1 ** (k / months[t, b])
        out[t:, b] = 1 - (1 - out[t:, b]) * (1 - drop[t, b] * np.where(k <= months[t, b], fade, 0.0))
    return out


def generate(seed: int = SEED, per_cell: int = PER_CELL) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    pop = pd.read_csv(DATA / "synthetic_businesses.csv", comment="#")
    pop = pop.groupby("location_name", group_keys=False).sample(per_cell, random_state=seed).reset_index(drop=True)
    months = pd.period_range(FIRST, LAST, freq="M")
    t, n = len(months), len(pop)

    base = (pop.turnover_inr / 12).values
    growth = rng.normal(*GROWTH, n)
    trend = (1 + growth) ** (np.arange(t)[:, None] / 12)
    shape = np.array([season(s) for s in pop.sector])[:, months.month - 1].T
    sigma = rng.uniform(*NOISE, n)
    noise = np.exp(rng.normal(0, 1, (t, n)) * sigma - sigma ** 2 / 2)

    events = event_months(months)
    drop_sys = np.zeros((t, n))
    onset_sys = np.zeros((t, n), dtype=bool)
    row = {m: i for i, m in enumerate(months)}
    for cell, month, kind in events.itertuples(index=False):
        members = np.nonzero((pop.location_name == cell).values)[0]
        sens = pop.loc[members, "sens_storm"].values if kind == "storm" else \
            pop.loc[members, ["sens_river_flood", "sens_flash_flood"]].max(axis=1).values
        d = sens * EVENT_DROP[kind] * rng.uniform(0.6, 1.0)
        i = row[month]
        drop_sys[i, members] = 1 - (1 - drop_sys[i, members]) * (1 - d)
        onset_sys[i, members] = True
    drop_idio = np.where(rng.random((t, n)) < IDIO_RATE, rng.uniform(*IDIO_DROP, (t, n)), 0.0)
    onset_idio = drop_idio > 0
    eff_sys = recovery(drop_sys, onset_sys, rng.integers(RECOVERY_MONTHS[0], RECOVERY_MONTHS[1] + 1, (t, n)))
    eff_idio = recovery(drop_idio, onset_idio, rng.integers(IDIO_RECOVERY_MONTHS[0], IDIO_RECOVERY_MONTHS[1] + 1, (t, n)))

    heat = heat_anomaly(months).reindex(index=months, columns=pop.location_name).values
    heat_loss = np.clip(np.nan_to_num(heat) - HEAT_ANOMALY_C, 0, None) * HEAT_LOSS_PER_C * pop.sens_heat.values

    revenue = base * trend * shape * noise * (1 - eff_sys) * (1 - eff_idio) * (1 - heat_loss)
    total_drop = 1 - (1 - eff_sys) * (1 - eff_idio)
    late = rng.random((t, n)) < np.clip(LATE_BASE + LATE_PER_DROP * total_drop, 0, 0.9)

    def frame(x: np.ndarray) -> pd.DataFrame:
        return pd.DataFrame(x, index=months.rename("month"), columns=pop.business_id.values)

    return {
        "population": pop, "revenue": frame(revenue.round(0)), "late": frame(late),
        "emi": pd.Series((base * EMI_SHARE).round(0), index=pop.business_id.values),
        "drop_systemic": frame(eff_sys), "drop_idiosyncratic": frame(eff_idio),
        "onset_systemic": frame(onset_sys & (drop_sys >= SHOCK_DROP)),
        "onset_idiosyncratic": frame(onset_idio),
    }


if __name__ == "__main__":
    g = generate()
    shocked = (1 - (1 - g["drop_systemic"]) * (1 - g["drop_idiosyncratic"])) >= SHOCK_DROP
    print(f"{g['revenue'].shape[1]} businesses x {g['revenue'].shape[0]} months; in shock {shocked.values.mean():.1%} of "
          f"business-months; onsets: {int(g['onset_systemic'].values.sum())} systemic, "
          f"{int(g['onset_idiosyncratic'].values.sum())} business-only; late payments {g['late'].values.mean():.1%}")
    if "--write" in sys.argv:
        long = pd.concat({k: g[k].stack() for k in ("revenue", "late", "drop_systemic", "drop_idiosyncratic")}, axis=1)
        long.index.names = ["month", "business_id"]
        path = DATA / "synthetic_monthly.csv"
        with open(path, "w") as fh:
            fh.write("# SYNTHETIC DATA: generated by ml/features/build_monthly.py; no real businesses\n")
            long.reset_index().to_csv(fh, index=False, float_format="%.4f")
        print(f"wrote {path}")
