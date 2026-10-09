"""Model 5's synthetic label generator and saved models, and POST /risk/climate-cashflow.

    cd ml && .venv-data/bin/python -m pytest tests -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import pytest
from fastapi.testclient import TestClient

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))
sys.path.insert(0, str(ML / "features"))

from app.main import app  # noqa: E402

client = TestClient(app)
PARAMS = ML / "data" / "hazard_params.csv"
needs_params = pytest.mark.skipif(not PARAMS.exists(), reason="run risk/hazard_params.py first")
RETAILER = {"monthly_revenue": 300_000, "variable_cost_share": 0.6, "fixed_costs": 75_000, "emi": 25_000,
            "starting_cash": 60_000, "sector": "retail", "date": "2026-06-01"}
GUWAHATI, JAISALMER = {"lat": 26.14, "lon": 91.74}, {"lat": 26.92, "lon": 70.9}


@pytest.fixture(scope="module")
def loans():
    if not PARAMS.exists():
        pytest.skip("run risk/hazard_params.py first")
    import build_pd as G
    return G, G.base_loans()


def test_labels_hit_the_target_default_rate_for_every_multiplier(loans):
    G, base = loans
    for m in G.MULTIPLIERS:
        d = G.label(base, m)
        assert d.true_pd.mean() == pytest.approx(G.TARGET_DEFAULT_RATE, abs=1e-4)
        assert d.default_12m.mean() == pytest.approx(G.TARGET_DEFAULT_RATE, abs=0.004)


def test_the_planted_multiplier_moves_only_shocked_loans(loans):
    G, base = loans
    calm, hot = G.label(base, 1.0), G.label(base, 2.0)
    shocked = base.climate_shock > 0.3
    odds = lambda p: p / (1 - p)  # noqa: E731
    ratio = odds(hot.true_pd) / odds(calm.true_pd)
    # odds ratio is m ** climate_shock, up to the shared intercept shift
    assert (ratio[shocked] / ratio[base.climate_shock == 0].mean()).round(6).equals(
        (2.0 ** base.climate_shock[shocked]).round(6))
    assert hot.true_pd[shocked].mean() > calm.true_pd[shocked].mean()


def test_label_shapes_are_monotonic(loans):
    G, base = loans
    d = G.label(base, 1.5)
    assert d.true_pd[d.dscr < 1].mean() > d.true_pd[d.dscr > 2].mean()
    assert d.true_pd[d.late_payments_12m >= 3].mean() > d.true_pd[d.late_payments_12m == 0].mean()


def test_saved_pd_models_score_loans_and_recovered_the_planted_effect(loans):
    G, base = loans
    report = ML / "models" / "pd_phase2_metrics.json"
    if not report.exists():
        pytest.skip("train model 5 first")
    for m in G.MULTIPLIERS:
        a = joblib.load(ML / "models" / f"pd_phase2_m{int(m * 10)}.joblib")
        p = a["model"].predict_proba(G.label(base, m).head(500))[:, 1]
        assert ((p >= 0) & (p <= 1)).all() and a["synthetic"] is True
    for r in json.loads(report.read_text())["by_multiplier"]:
        assert r["recovery"]["planted_inside_interval"]
        assert r[r["kept"]]["brier"] < r["baseline_rate_by_size"]["brier"]


@needs_params
def test_flood_prone_city_gets_a_larger_climate_effect_than_a_desert_one():
    wet = client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI}).json()
    dry = client.post("/risk/climate-cashflow", json={**RETAILER, **JAISALMER}).json()
    assert wet["scored"] and wet["cell"] == "Guwahati" and dry["cell"] == "Jaisalmer"
    assert wet["delta_pd_climate"] > dry["delta_pd_climate"] >= 0
    assert wet["climate_premium_bps"] == pytest.approx(wet["delta_pd_climate"] * 4500, abs=0.5)
    assert wet["assumptions"] and wet["what_if"]


@needs_params
def test_alert_base_pd_and_bad_requests():
    r = client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI, "pd_base": 0.04,
                                                    "alert_hazard": "flash_flood", "alert_p_event": 0.8}).json()
    quiet = client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI}).json()
    assert r["p_cash_short_30d"] > quiet["p_cash_short_30d"]
    assert r["climate_adjusted_pd"] == pytest.approx(min(0.04 + r["delta_pd_climate"], 1), abs=1e-4)
    far = client.post("/risk/climate-cashflow", json={**RETAILER, "lat": 0.0, "lon": 0.0}).json()
    assert far["scored"] is False
    assert client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI, "sector": "no_such"}).status_code == 422
    assert client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI, "alert_hazard": "storm"}).status_code == 422
    assert client.post("/risk/climate-cashflow", json={**RETAILER, **GUWAHATI, "monthly_revenue": 0}).status_code == 422
