"""EDA checks that drive a modelling decision (plan section 3). Prints the
numbers and saves figures to ml/eda/figures/.

    python ml/eda/eda.py
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

ML = Path(__file__).resolve().parents[1]
DATA = ML / "data"
FIG = ML / "eda" / "figures"
IMD_HEAVY_MM = 64.5


def load():
    w = pd.read_csv(DATA / "weather_dataset.csv", parse_dates=["date"])
    f = pd.read_csv(DATA / "events_flood.csv", parse_dates=["start_date", "end_date"])
    s = pd.read_csv(DATA / "events_storm.csv", parse_dates=["date"])
    spine = pd.read_csv(DATA / "spine.csv")
    return w, f, s, spine


def rain_signal(w: pd.DataFrame, f: pd.DataFrame) -> None:
    """Does rain before a flood stand out, and in absolute or relative terms?"""
    w = w.sort_values(["location_name", "date"]).copy()
    w["rain3"] = w.groupby("location_name").precipitation_sum.transform(lambda x: x.rolling(3, 1).sum())
    w["pct"] = w.groupby("location_name").rain3.rank(pct=True)
    # each flood: the wettest 3-day total from 3 days before to 1 day after the start
    rows = []
    for e in f[f.start_date.dt.year <= 2023].itertuples():
        win = w[(w.location_name == e.location_name)
                & w.date.between(e.start_date - pd.Timedelta(days=3), e.start_date + pd.Timedelta(days=1))]
        if len(win):
            top = win.loc[win.rain3.idxmax()]
            rows.append({"location_name": e.location_name, "rain3": top.rain3, "pct": top.pct,
                         "day_max": win.precipitation_sum.max()})
    ev = pd.DataFrame(rows)
    print("\n-- 3.1/3.2 rain around IFI flood starts (wettest 3-day total, day -3..+1)")
    print(f"floods checked {len(ev)}; median percentile of that total vs the cell's own history: "
          f"{ev.pct.median():.3f}")
    for p in (0.90, 0.95, 0.99):
        print(f"  share of floods with 3-day rain above the cell's p{int(p*100)}: {(ev.pct >= p).mean():.2f}")
    print(f"  share of floods with a day >= IMD heavy ({IMD_HEAVY_MM} mm): {(ev.day_max >= IMD_HEAVY_MM).mean():.2f}")
    print(f"  share of floods with < 10 mm in the window (rain cannot explain them): "
          f"{(ev.rain3 < 10).mean():.2f}")

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(w.pct.sample(50_000, random_state=0), bins=40, density=True, alpha=0.5, label="all days")
    ax.hist(ev.pct, bins=40, density=True, alpha=0.6, label="around IFI flood starts")
    ax.set_xlabel("3-day rain, percentile of the cell's own history")
    ax.set_ylabel("density")
    ax.set_title("Floods follow locally extreme rain, not a fixed mm value")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIG / "flood_rain_percentile.png", dpi=120)


def alert_volume(w: pd.DataFrame) -> None:
    """How often would an IMD-absolute vs a per-cell-percentile tripwire fire?"""
    print("\n-- 3.1 alert days per year: IMD 64.5 mm vs cell p99")
    p99 = w.groupby("location_name").precipitation_sum.transform(lambda x: x.quantile(0.99))
    years = w.date.dt.year.nunique()
    t = pd.DataFrame({
        "imd_64.5mm": (w.precipitation_sum >= IMD_HEAVY_MM).groupby(w.location_name).sum() / years,
        "cell_p99": (w.precipitation_sum >= p99).groupby(w.location_name).sum() / years,
    }).round(1)
    print(t.describe().loc[["min", "50%", "max"]].to_string())
    print("cells where IMD heavy fires < 0.5 days a year:",
          ", ".join(t.index[t["imd_64.5mm"] < 0.5]))


def trends(w: pd.DataFrame) -> None:
    print("\n-- 3.1 trend in annual extremes, 1995-2025 (median across cells, per decade)")
    w = w[w.date.dt.year <= 2025]
    a = w.groupby(["location_name", w.date.dt.year]).agg(
        rx1day=("precipitation_sum", "max"),
        hot_days=("temperature_2m_max", lambda x: (x >= 40).sum()),
        tmax_p99=("temperature_2m_max", lambda x: x.quantile(0.99)),
    ).reset_index()
    for col in ["rx1day", "hot_days", "tmax_p99"]:
        slopes = a.groupby("location_name").apply(
            lambda g: np.polyfit(g.date, g[col], 1)[0] * 10, include_groups=False)
        print(f"  {col:9s} median slope {slopes.median():+.2f}/decade, "
              f"{(slopes > 0).mean():.0%} of cells rising")


def duplicates(w: pd.DataFrame) -> None:
    print("\n-- 3.1 near-duplicate variables (|r| > 0.9)")
    num = w.select_dtypes("number").drop(columns=["lat", "lon", "cell_lat", "cell_lon"], errors="ignore")
    c = num.corr().abs()
    pairs = [(a, b, round(c.loc[a, b], 3)) for i, a in enumerate(c) for b in c.columns[i + 1:] if c.loc[a, b] > 0.9]
    for p in pairs:
        print("  ", p)


def flood_tables(f: pd.DataFrame) -> None:
    print("\n-- 3.2 IFI duration (days) for spine cells")
    d = (f.end_date - f.start_date).dt.days + 1
    print("  ", d.describe(percentiles=[.5, .75, .9]).round(1).to_dict())
    fig, ax = plt.subplots(figsize=(8, 3.5))
    f.groupby(f.start_date.dt.year).size().plot.bar(ax=ax, color="#4a7bb7")
    ax.set_title("IFI floods per year in our 38 cells: reporting jumps in 2021-23")
    ax.set_xlabel("")
    fig.tight_layout()
    fig.savefig(FIG / "ifi_floods_per_year.png", dpi=120)


def storm_season(s: pd.DataFrame) -> None:
    print("\n-- 3.3 storm-cell days by season (within 150 km)")
    s = s[s.min_distance_km <= 150]
    season = np.select([s.date.dt.month.isin([4, 5, 6]), s.date.dt.month.isin([10, 11, 12])],
                       ["pre-monsoon", "post-monsoon"], "other")
    print("  ", pd.Series(season).value_counts().to_dict(),
          f"| storm-cell pairs {s.groupby(['location_name', 'storm_id']).ngroups}")


if __name__ == "__main__":
    FIG.mkdir(parents=True, exist_ok=True)
    w, f, s, spine = load()
    print(f"weather {w.shape}, NaN share: "
          f"{ {k: round(v, 3) for k, v in w.isna().mean().items() if v > 0} }")
    alert_volume(w)
    rain_signal(w, f)
    trends(w)
    duplicates(w)
    flood_tables(f)
    storm_season(s)
    print(f"\nfigures in {FIG}")
