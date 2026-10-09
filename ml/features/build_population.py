"""Synthetic MSME population for models 5 and 6 (plan section 2.3).

EVERY ROW IS SYNTHETIC. Businesses are placed in the 38 weather cells so
their climate history is already on disk. Udyam district counts were not
downloaded, so the mixes below are assumptions, marked as such.

    python ml/features/build_population.py   # writes ml/data/synthetic_businesses.csv
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from spine import DATA, build as build_spine

SEED = 7
PER_CELL = 100  # ASSUMED: equal count per cell (no Udyam weights)

# ASSUMED. Udyam is ~98% micro; small and medium are oversampled so model 5
# sees enough of them (plan section 3.4)
SIZE_MIX = {"micro": 0.85, "small": 0.12, "medium": 0.03}
# Turnover bands in INR per the MSME limits revised from 1 April 2025
# (micro <= 10 cr, small <= 100 cr, medium <= 500 cr). VERIFY before slides.
CRORE = 10_000_000
TURNOVER_BANDS = {"micro": (0.05 * CRORE, 10 * CRORE), "small": (10 * CRORE, 100 * CRORE),
                  "medium": (100 * CRORE, 500 * CRORE)}

# ASSUMED sector shares, input-service sector names
SECTOR_MIX = {
    "retail": 0.22, "food_beverage": 0.10, "food_processing": 0.07, "agriculture": 0.08,
    "manufacturing": 0.12, "apparel_footwear": 0.06, "construction": 0.06, "logistics": 0.05,
    "hospitality_tourism": 0.04, "healthcare_pharmacy": 0.04, "automotive": 0.04,
    "home_improvement": 0.03, "delivery_ecommerce": 0.03, "entertainment_leisure": 0.02,
    "other": 0.04,
}
MANUFACTURING = {"food_processing", "manufacturing", "apparel_footwear", "agriculture"}

HAZARDS = ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"]
# (physical, demand) per sector and hazard, copied from the input service's
# sector defaults: api/src/services/input/classifier/defaults.ts
IMPACT = {
    "retail":                [(0.6, -0.4), (0.4, -0.4), (0.1, -0.1), (0.05, 0), (0.4, -0.3), (0.05, -0.1)],
    "apparel_footwear":      [(0.6, -0.4), (0.4, -0.4), (0.1, 0.1), (0.05, 0), (0.4, -0.3), (0.05, 0.3)],
    "food_beverage":         [(0.6, -0.4), (0.4, -0.3), (0.15, 0.3), (0.15, -0.1), (0.4, -0.3), (0.05, 0.1)],
    "food_processing":       [(0.7, -0.1), (0.4, 0), (0.3, 0), (0.5, 0), (0.4, 0), (0.1, 0)],
    "delivery_ecommerce":    [(0.6, -0.1), (0.4, 0.4), (0.2, 0.3), (0.05, 0), (0.5, 0.2), (0.1, 0.2)],
    "agriculture":           [(0.9, 0), (0.7, 0), (0.6, 0), (0.9, 0), (0.7, 0), (0.5, 0)],
    "construction":          [(0.8, -0.1), (0.7, 0), (0.5, 0), (0.2, 0), (0.7, 0.1), (0.2, 0)],
    "manufacturing":         [(0.7, -0.1), (0.4, 0), (0.25, 0), (0.3, 0), (0.4, 0), (0.1, 0)],
    "hospitality_tourism":   [(0.7, -0.6), (0.4, -0.5), (0.15, -0.3), (0.2, -0.1), (0.5, -0.5), (0.1, -0.1)],
    "logistics":             [(0.8, 0), (0.6, 0), (0.2, 0), (0.05, 0), (0.6, 0), (0.3, 0)],
    "entertainment_leisure": [(0.6, -0.5), (0.3, 0.1), (0.1, 0.2), (0.05, 0), (0.4, -0.3), (0.05, 0)],
    "healthcare_pharmacy":   [(0.6, 0.2), (0.3, 0.2), (0.05, 0.3), (0.05, 0.1), (0.3, 0.1), (0.05, 0.3)],
    "home_improvement":      [(0.6, 0.3), (0.4, 0.1), (0.1, 0.2), (0.05, 0), (0.4, 0.4), (0.05, 0.1)],
    "automotive":            [(0.7, 0.2), (0.4, 0.1), (0.1, 0.2), (0.05, 0), (0.4, 0.1), (0.05, 0.1)],
    "other":                 [(0.6, -0.2), (0.4, -0.2), (0.15, 0), (0.1, 0), (0.4, -0.2), (0.05, 0)],
}


def revenue_loss(physical: float, demand: float) -> float:
    """Share of revenue lost in a severe event; same formula as revenueEffect()
    in api/src/services/finance/scoring/sensitivity.ts, gains clipped to 0."""
    return round(max(0.0, 1 - (1 - physical) * (1 + demand)), 4)


def build() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    spine = build_spine()
    n = PER_CELL * len(spine)
    cells = spine.loc[np.repeat(spine.index, PER_CELL)].reset_index(drop=True)
    size = rng.choice(list(SIZE_MIX), n, p=list(SIZE_MIX.values()))
    sector = rng.choice(list(SECTOR_MIX), n, p=list(SECTOR_MIX.values()))
    lo = np.array([TURNOVER_BANDS[s][0] for s in size])
    hi = np.array([TURNOVER_BANDS[s][1] for s in size])
    # log-uniform within the band, skewed to the bottom: most firms are small
    u = rng.beta(1.2, 3.0, n)
    turnover = np.exp(np.log(lo) + u * (np.log(hi) - np.log(lo)))

    out = pd.DataFrame({
        "business_id": [f"SYN-{i:05d}" for i in range(n)],
        "location_name": cells.location_name,
        "region": cells.region,
        "coastal": cells.coastal,
        "sector": sector,
        "size": size,
        "activity": np.where(np.isin(sector, list(MANUFACTURING)), "manufacturing", "services"),
        "turnover_inr": turnover.round(-3),
        "years_in_operation": rng.integers(1, 31, n),
    })
    for i, hazard in enumerate(HAZARDS):
        out[f"sens_{hazard}"] = [revenue_loss(*IMPACT[s][i]) for s in sector]
    return out


if __name__ == "__main__":
    df = build()
    path = DATA / "synthetic_businesses.csv"
    with open(path, "w") as fh:
        fh.write("# SYNTHETIC DATA: generated by ml/features/build_population.py; no real businesses\n")
        df.to_csv(fh, index=False)
    print(f"wrote {path}: {len(df)} businesses")
    print(df["size"].value_counts(normalize=True).round(3).to_dict())
    print(df.groupby("size").turnover_inr.median().div(CRORE).round(2).to_dict(), "(median, crore)")
    print(df.filter(like="sens_").describe().loc[["mean", "min", "max"]].round(2).to_string())
