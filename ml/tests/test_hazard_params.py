"""Hazard parameter checks on made-up events, plus the committed table.

    cd ml && .venv-data/bin/python -m pytest tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML / "risk"))

import hazard_params as H  # noqa: E402

PARAMS = ML / "data" / "hazard_params.csv"


def test_consecutive_days_merge_into_one_event():
    days = pd.DataFrame({"location_name": ["A"] * 4 + ["B"],
                         "date": pd.to_datetime(["2020-07-01", "2020-07-02", "2020-07-03", "2020-07-10", "2020-07-02"])})
    e = H.merge_days(days, "heat").sort_values(["location_name", "start"])
    assert e.duration.tolist() == [3, 1, 1]
    assert e.start.dt.strftime("%Y-%m-%d").tolist() == ["2020-07-01", "2020-07-10", "2020-07-02"]


def test_one_bad_year_cannot_push_the_rate_past_the_cap():
    years = np.arange(1995, 2024)
    counts = np.zeros(len(years))
    counts[-1] = 30  # a single extreme final year
    rate, _ = H.fit_rate(years, counts, np.array([H.TARGET_YEAR]), trend=True)
    assert rate[0] <= counts.mean() * H.TREND_CAP + 1e-9


def test_no_events_means_a_zero_rate_and_no_trend_keeps_the_mean():
    years = np.arange(1995, 2024)
    assert H.fit_rate(years, np.zeros(29), np.array([2026]), trend=True)[0][0] == 0
    rate, beta = H.fit_rate(years, np.arange(29.0), np.array([2026]), trend=False)
    assert rate[0] == pytest.approx(14.0) and beta == 0


def test_spi_marks_the_driest_months_and_ignores_normally_dry_ones():
    rng = np.random.default_rng(0)
    dates = pd.date_range("1995-01-01", "2023-12-31")
    rain = rng.gamma(0.4, 12.0, len(dates)) * np.isin(dates.month, [6, 7, 8, 9])  # dry outside the monsoon
    w = pd.DataFrame({"location_name": "A", "date": dates, "precipitation_sum": rain})
    s = H.spi3(w)
    dry = s[s.spi <= H.SPI_DRY]
    assert 0.05 < len(dry) / len(s) < 0.25
    # Jan-May totals are all zero every year: never a drought
    assert not dry.date.dt.month.isin([3, 4, 5]).any()


@pytest.mark.skipif(not PARAMS.exists(), reason="run risk/hazard_params.py first")
def test_committed_table_covers_every_cell_and_hazard_with_sane_values():
    hp = pd.read_csv(PARAMS)
    spine = pd.read_csv(ML / "data" / "spine.csv")
    assert len(hp) == len(spine) * len(H.HAZARDS)
    assert (hp.events_per_year >= 0).all() and (hp.mean_duration >= 1).all()
    assert (hp.events_per_year <= hp.events_per_year_mean * H.TREND_CAP + 1e-3).all()  # both are rounded
    rate = hp.pivot(index="location_name", columns="hazard", values="events_per_year")
    assert rate.loc["Guwahati", "river_flood"] > rate.loc["Jaisalmer", "river_flood"]
    assert rate.loc["Leh", "storm"] == 0 and rate.loc["Puri", "storm"] > 0
    assert rate.loc["Leh", "heat"] == 0 and rate.loc["Jaisalmer", "heat"] > 1
