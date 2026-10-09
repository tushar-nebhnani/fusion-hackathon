"""Synthetic loans and default labels for model 5 (plan section 5.2).

EVERY ROW IS SYNTHETIC. The label formula is deliberately not the
scorecard's: its own shapes and weights, an intercept tuned to an assumed
4% default rate, and a planted climate multiplier `m` that the training
pipeline must find again. Shocks land on real flood and storm years.

    python ml/features/build_pd.py   # prints a summary for m = 1.0, 1.5, 2.0
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ML = Path(__file__).resolve().parents[1]
DATA = ML / "data"

SEED = 23
HAZARDS = ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"]
MULTIPLIERS = (1.0, 1.5, 2.0)
# One loan per business per year, so shocks fall on real event years
LOAN_YEARS = (2004, 2023)
STORM_RADIUS_KM = 150
# CAFRAL: disaster stress on loans is concentrated in the two years after
SHOCK_YEARS = 2
# ASSUMED. Disrupted days a year at which a cell's hazard score reaches 63%
SCORE_SCALE_DAYS = 15.0
DROUGHT_DAYS_PER_DRY_MONTH = 5.0

# Calibration targets. NOT VERIFIED against their sources (notes section 7):
# MSME gross NPA about 4%, micro below small and medium, agri-linked higher
TARGET_DEFAULT_RATE = 0.04
B_SIZE = {"micro": 0.0, "small": 0.25, "medium": 0.10}
B_AGRI = 0.45
AGRI = {"agriculture", "food_processing"}
# ASSUMED shapes, all monotonic
DSCR_SLOPE = -1.2
BUFFER_SLOPE = -0.5
LATE_SLOPE = 0.35
NOISE_SD = 0.3

NUMERIC = ["dscr", "cash_buffer_days", "revenue_volatility", "debt_to_revenue", "late_payments_12m",
           "years_in_operation", "log_loan_to_turnover", "tenure_months", "is_manufacturing",
           *[f"exposure_{h}" for h in HAZARDS], "combined_exposure", "climate_shock", "exposure_x_low_buffer"]
CATEGORICAL = ["size", "sector"]
CLIMATE = [*[f"exposure_{h}" for h in HAZARDS], "combined_exposure", "climate_shock", "exposure_x_low_buffer"]
# +1: default risk rises with the feature, -1: falls (plan section 5.4)
MONOTONIC = {"dscr": -1, "cash_buffer_days": -1, "debt_to_revenue": 1, "late_payments_12m": 1}


def hazard_scores() -> pd.DataFrame:
    """cells x hazards, 0-1, from the measured event rates in hazard_params.csv."""
    hp = pd.read_csv(DATA / "hazard_params.csv")
    days = hp.events_per_year * np.where(hp.unit == "months", DROUGHT_DAYS_PER_DRY_MONTH, hp.mean_duration)
    return hp.assign(score=1 - np.exp(-days / SCORE_SCALE_DAYS)).pivot(index="location_name", columns="hazard", values="score")


def event_years() -> set[tuple[str, int]]:
    floods = pd.read_csv(DATA / "events_flood.csv", parse_dates=["start_date"])
    storms = pd.read_csv(DATA / "events_storm.csv", parse_dates=["date"])
    storms = storms[storms.min_distance_km <= STORM_RADIUS_KM]
    return set(zip(floods.location_name, floods.start_date.dt.year)) | set(zip(storms.location_name, storms.date.dt.year))


def base_loans(seed: int = SEED) -> pd.DataFrame:
    """Loans and everything except the label; the same for every multiplier."""
    rng = np.random.default_rng(seed)
    pop = pd.read_csv(DATA / "synthetic_businesses.csv", comment="#")
    years = np.arange(LOAN_YEARS[0], LOAN_YEARS[1] + 1)
    d = pop.loc[np.repeat(pop.index, len(years))].reset_index(drop=True)
    d["loan_year"] = np.tile(years, len(pop))
    n = len(d)
    d["dscr"] = np.clip(rng.lognormal(np.log(1.4), 0.35, n), 0.3, 5.0)
    d["cash_buffer_days"] = np.clip(rng.gamma(1.5, 25.0, n), 0, 365)
    d["revenue_volatility"] = rng.beta(2, 8, n)
    d["debt_to_revenue"] = np.clip(rng.lognormal(np.log(0.35), 0.6, n), 0, 3.0)
    d["late_payments_12m"] = np.minimum(rng.poisson(0.6, n), 12)
    d["log_loan_to_turnover"] = rng.normal(np.log(0.15), 0.5, n)
    d["tenure_months"] = rng.choice([12, 24, 36, 48, 60], n)
    d["is_manufacturing"] = (d.activity == "manufacturing").astype(int)

    scores = hazard_scores()
    for h in HAZARDS:
        d[f"exposure_{h}"] = d.location_name.map(scores[h]).values * d[f"sens_{h}"].values
    d["combined_exposure"] = 1 - np.prod([1 - d[f"exposure_{h}"] for h in HAZARDS], axis=0)
    hit = event_years()
    recent = np.array([any((c, y - k) in hit for k in range(SHOCK_YEARS)) for c, y in zip(d.location_name, d.loan_year)])
    wet = 1 - np.prod([1 - d[f"exposure_{h}"] for h in ("river_flood", "flash_flood", "storm")], axis=0)
    d["event_in_window"] = recent.astype(int)
    d["climate_shock"] = wet * recent
    d["exposure_x_low_buffer"] = d.combined_exposure * (d.cash_buffer_days < 15)
    d["noise"] = rng.normal(0, NOISE_SD, n)
    d["u"] = rng.random(n)
    return d


def label(d: pd.DataFrame, m: float) -> pd.DataFrame:
    """Add true_pd and default_12m for climate multiplier m."""
    z = (d["size"].map(B_SIZE) + B_AGRI * d.sector.isin(AGRI)
         + DSCR_SLOPE * np.log(d.dscr / 1.4) + BUFFER_SLOPE * np.log((d.cash_buffer_days + 5) / 35)
         + LATE_SLOPE * np.minimum(d.late_payments_12m, 6)
         + np.log(m) * d.climate_shock + d.noise).values
    lo, hi = -15.0, 5.0
    for _ in range(60):  # intercept that gives the target default rate
        a = (lo + hi) / 2
        lo, hi = (a, hi) if (1 / (1 + np.exp(-(a + z)))).mean() < TARGET_DEFAULT_RATE else (lo, a)
    pd_true = 1 / (1 + np.exp(-(a + z)))
    return d.assign(true_pd=pd_true, default_12m=(d.u < pd_true).astype(int))


if __name__ == "__main__":
    base = base_loans()
    print(f"{len(base)} synthetic loans, {base.business_id.nunique()} businesses, "
          f"{base.event_in_window.mean():.0%} with a real flood or storm in the window")
    for m in MULTIPLIERS:
        d = label(base, m)
        top = d[d.climate_shock >= d.climate_shock[d.climate_shock > 0].quantile(0.75)]
        print(f"m={m}: default rate {d.default_12m.mean():.3%}; by size {d.groupby('size').default_12m.mean().round(4).to_dict()}; "
              f"agri {d[d.sector.isin(AGRI)].default_12m.mean():.3%}; most-shocked quarter {top.default_12m.mean():.3%}")
