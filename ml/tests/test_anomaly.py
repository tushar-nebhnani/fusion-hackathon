"""Model 6 checks: features, the rule, and POST /anomaly. Made-up series only.

    cd ml && .venv-data/bin/python -m pytest tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))
sys.path.insert(0, str(ML / "features"))

import anomaly as F  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
MODEL = ML / "models" / "cashflow_anomaly.joblib"
needs_model = pytest.mark.skipif(not MODEL.exists(), reason="train model 6 first")
FESTIVE = [0.95, 0.9, 0.95, 0.95, 0.95, 0.9, 0.9, 0.95, 1.0, 1.25, 1.25, 1.05]


def series(months: int = 36, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return 500_000 * np.tile(FESTIVE, months // 12) * np.exp(rng.normal(0, 0.05, months))


def test_features_use_only_the_past_and_the_current_month():
    a = series()
    b = a.copy()
    b[-1] *= 0.3  # change only the last month
    fa, fb = F.panel_features(pd.DataFrame({"b": a})), F.panel_features(pd.DataFrame({"b": b}))
    for name in F.ANOMALY_FEATURES:
        assert np.allclose(fa[name]["b"].iloc[:-1], fb[name]["b"].iloc[:-1], equal_nan=True), name
    assert fb["seasonal_z"]["b"].iloc[-1] < fa["seasonal_z"]["b"].iloc[-1]


def test_a_seasonal_dip_is_not_an_anomaly_but_a_real_drop_is():
    steady = F.panel_features(pd.DataFrame({"b": series()}))["seasonal_z"]["b"]
    assert steady.iloc[-12:].min() > F.RULE_Z  # the yearly Feb dip is expected
    hit = series()
    hit[-2:] *= 0.4
    assert F.rule_flags(F.panel_features(pd.DataFrame({"b": hit}))["seasonal_z"])["b"].iloc[-1]


def test_run_length_counts_consecutive_months():
    flag = pd.DataFrame({"b": [False, True, True, False, True]})
    assert F.run_length(flag)["b"].tolist() == [0, 1, 2, 0, 1]


@needs_model
def test_steady_business_is_not_flagged():
    r = client.post("/anomaly", json={"monthly_revenue": series().tolist()})
    assert r.status_code == 200
    assert r.json()["flagged"] is False and r.json()["type"] is None


@needs_model
def test_sharp_drop_is_flagged_and_typed_by_what_the_cell_is_doing():
    hit = series()
    hit[-2:] *= 0.4
    body = {"monthly_revenue": hit.tolist(), "late_payments": [False] * 34 + [True, True]}
    alone = client.post("/anomaly", json={**body, "cell_anomalous_share": 0.02}).json()
    shared = client.post("/anomaly", json={**body, "cell_anomalous_share": 0.6}).json()
    assert alone["flagged"] and alone["type"] == "idiosyncratic"
    assert shared["flagged"] and shared["type"] == "systemic"
    assert alone["months_flagged"] >= 1
    calm = client.post("/anomaly", json={"monthly_revenue": series().tolist()}).json()
    assert alone["anomaly_score"] > calm["anomaly_score"]
    assert client.post("/anomaly", json={**body, "climate_event_in_cell": True}).json()["type"] == "systemic"


def test_short_or_mismatched_series_is_rejected():
    assert client.post("/anomaly", json={"monthly_revenue": [1.0] * 12}).status_code == 422
    r = client.post("/anomaly", json={"monthly_revenue": series().tolist(), "late_payments": [False] * 3})
    assert r.status_code == 422
