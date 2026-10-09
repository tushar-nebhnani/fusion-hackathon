"""Cash-flow simulation checks (risk plan section 6). Made-up business and
hazard rates; no data files, no network.

    cd ml && .venv-data/bin/python -m pytest tests -q
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from risk.cashflow_sim import Business, draws, run, simulate  # noqa: E402

V = {"river_flood": 0.6, "flash_flood": 0.6, "heat": 0.1, "drought": 0.1, "storm": 0.4, "cold_wave": 0.05}
HAZARDS = {
    "river_flood": {"events_per_year": 2.0, "mean_duration": 6.0},
    "flash_flood": {"events_per_year": 1.0, "mean_duration": 1.5},
    "heat": {"events_per_year": 1.5, "mean_duration": 3.0},
    "drought": {"events_per_year": 1.8, "mean_duration": 1.0},
    "storm": {"events_per_year": 0.3, "mean_duration": 1.2},
    "cold_wave": {"events_per_year": 0.5, "mean_duration": 2.0},
}
B = Business(monthly_revenue=300_000, variable_cost_share=0.6, fixed_costs=75_000, emi=25_000,
             starting_cash=60_000, revenue_volatility=0.2, vulnerability=V, sector="retail")
N = 8_000


def pd_with(b: Business = B, hazards: dict = HAZARDS, **kw) -> float:
    return run(b, hazards, draws(N, 12, seed=3), **kw)["pd_with"]


def test_climate_never_lowers_the_default_rate_and_no_vulnerability_means_no_effect():
    r = simulate(B, HAZARDS, n=N)
    assert r["delta_pd_climate"] > 0
    calm = simulate(replace(B, vulnerability={}), HAZARDS, n=N)
    assert calm["delta_pd_climate"] == 0
    assert calm["expected_annual_climate_loss"] == 0


@pytest.mark.parametrize("change", [
    {"starting_cash": 200_000}, {"insurance_recovery": 0.5}, {"backup_power": True},
])
def test_more_protection_never_raises_the_default_rate(change):
    assert pd_with(replace(B, **change)) <= pd_with()


@pytest.mark.parametrize("hazard,key,value", [
    ("river_flood", "events_per_year", 4.0), ("river_flood", "mean_duration", 12.0), ("drought", "events_per_year", 4.0),
])
def test_more_frequent_or_longer_events_never_lower_the_default_rate(hazard, key, value):
    worse = {**HAZARDS, hazard: {**HAZARDS[hazard], key: value}}
    assert pd_with(hazards=worse) >= pd_with()


def test_higher_vulnerability_never_lowers_the_default_rate():
    assert pd_with(replace(B, vulnerability={**V, "river_flood": 0.9})) >= pd_with()


def test_result_is_stable_between_10k_and_40k_paths():
    a = simulate(B, HAZARDS, n=10_000, seed=1)["delta_pd_climate"]
    b = simulate(B, HAZARDS, n=40_000, seed=2)["delta_pd_climate"]
    assert abs(a - b) < 0.02


def test_an_active_alert_raises_the_chance_of_running_short_this_month():
    quiet = simulate(B, HAZARDS, n=N)
    alert = simulate(B, HAZARDS, n=N, alert={"hazard": "river_flood", "p_event": 0.9})
    assert alert["p_cash_short_30d"] > quiet["p_cash_short_30d"]
    assert alert["pd_without_climate"] == quiet["pd_without_climate"]


def test_premium_and_adjusted_pd_follow_from_the_difference():
    r = simulate(B, HAZARDS, n=N, pd_base=0.05)
    assert r["climate_premium_bps"] == pytest.approx(r["delta_pd_climate"] * 0.45 * 10_000, abs=0.5)
    assert r["climate_adjusted_pd"] == pytest.approx(0.05 + r["delta_pd_climate"], abs=1e-4)
    assert r["climate_cfar95"] >= r["expected_annual_climate_loss"]
    assert {w["condition"] for w in r["what_if"]} >= {"install backup power"}
    assert all(w["pd_change"] <= 0 for w in r["what_if"])
