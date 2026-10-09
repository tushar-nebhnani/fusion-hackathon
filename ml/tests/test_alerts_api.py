"""Model 4 service tests. Needs the trained model and the weather data
(the model is committed; weather is re-creatable); skips when absent.

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

MODEL = ML / "models" / "alert_calibration_flood.joblib"
WEATHER = ML / "data" / "weather_dataset.csv"
pytestmark = pytest.mark.skipif(
    not (MODEL.exists() and MODEL.with_name("alert_calibration_storm.joblib").exists()), reason="train model 4 first")

from app.main import CalibrateRequest, app, flood_features, model, storm_features  # noqa: E402

client = TestClient(app)
MUMBAI = {"lat": 19.08, "lon": 72.88}
PURI = {"lat": 19.81, "lon": 85.83}


def test_heavy_rain_in_a_trained_cell_gets_a_probability_and_band():
    r = client.post("/alerts/calibrate", json={
        "hazard": "flood", **MUMBAI, "date": "2023-07-20",
        "precipitation_sum": [5.0] * 27 + [80.0, 120.0, 150.0],
    })
    body = r.json()
    assert r.status_code == 200
    assert 0.0 <= body["p_event"] <= 1.0
    assert body["band"] in {"low", "medium", "high"}
    assert body["cell"] == "Mumbai"


def test_wetter_alert_scores_at_least_as_high_as_a_drier_one():
    def p(rain):
        return client.post("/alerts/calibrate", json={
            "hazard": "flood", **MUMBAI, "date": "2023-07-20", "precipitation_sum": rain,
        }).json()["p_event"]
    assert p([5.0] * 27 + [80.0, 120.0, 250.0]) >= p([0.0] * 29 + [66.0])


def test_point_far_from_every_cell_is_unscored_so_the_alert_goes_out_unchanged():
    r = client.post("/alerts/calibrate", json={
        "hazard": "flood", "lat": 0.0, "lon": 0.0, "date": "2023-07-20", "precipitation_sum": [100.0],
    })
    assert r.json()["band"] == "unscored"
    assert r.json()["p_event"] is None


def test_storm_without_wind_and_pressure_stays_rule_only():
    r = client.post("/alerts/calibrate", json={
        "hazard": "storm", **MUMBAI, "date": "2023-06-10", "precipitation_sum": [100.0],
    })
    assert r.json()["band"] == "baseline"
    assert r.json()["p_event"] is None


def storm_p(wind: float, pressure: float) -> dict:
    return client.post("/alerts/calibrate", json={
        "hazard": "storm", **PURI, "date": "2023-10-25", "precipitation_sum": [10.0, 40.0, 90.0],
        "wind_speed_10m_max": [wind], "surface_pressure_mean": [pressure],
    }).json()


def test_storm_with_wind_and_pressure_gets_a_probability_and_band():
    body = storm_p(wind=60.0, pressure=990.0)
    assert 0.0 <= body["p_event"] <= 1.0
    assert body["band"] in {"low", "medium", "high"}
    assert body["cell"] == "Puri"


def test_stronger_wind_and_lower_pressure_score_higher_for_storm():
    assert storm_p(wind=80.0, pressure=980.0)["p_event"] > storm_p(wind=20.0, pressure=1008.0)["p_event"]


def test_invalid_request_is_rejected():
    r = client.post("/alerts/calibrate", json={"hazard": "flood", **MUMBAI, "date": "2023-07-20",
                                               "precipitation_sum": []})
    assert r.status_code == 422


def test_model_files_stay_small_enough_for_git():
    for path in (ML / "models").glob("*.joblib"):
        assert path.stat().st_size < 1_000_000, f"{path.name} is over 1 MB"


@pytest.mark.skipif(not WEATHER.exists(), reason="weather data not fetched")
def test_service_features_match_training_features():
    """Train/serve parity: the service must rebuild the exact features the
    model was trained on from a plain 30-day series."""
    import alerts as A

    weather, spine, floods, _ = A.load()
    weather = weather[weather.location_name == "Mumbai"]
    w = A.daily_features(weather, spine, floods)
    day = pd.Timestamp("2005-07-26")  # the Mumbai deluge
    row = w[w.date == day].iloc[0]
    hist = w[(w.date > day - pd.Timedelta(days=30)) & (w.date <= day)]
    req = CalibrateRequest(
        hazard="flood", lat=19.08, lon=72.88, date=day.date(),
        precipitation_sum=hist.rain.tolist(), soil_wetness_top=hist.soil.tolist(),
        relative_humidity_2m_mean=hist.rh.tolist(),
    )
    got = flood_features(req, model("flood")["cells"]["Mumbai"])
    for name in A.FLOOD_FEATURES:
        assert np.isclose(got[name], row[name], rtol=1e-6, atol=1e-6), name


@pytest.mark.skipif(not WEATHER.exists(), reason="weather data not fetched")
def test_service_storm_features_match_training_features():
    import alerts as A

    weather, spine, floods, _ = A.load()
    weather = weather[weather.location_name == "Puri"]
    w = A.daily_features(weather, spine, floods)
    day = pd.Timestamp("2019-05-03")  # cyclone Fani at Puri
    row = w[w.date == day].iloc[0]
    hist = w[(w.date > day - pd.Timedelta(days=30)) & (w.date <= day)]
    req = CalibrateRequest(
        hazard="storm", **PURI, date=day.date(),
        precipitation_sum=hist.rain.tolist(), relative_humidity_2m_mean=hist.rh.tolist(),
        wind_speed_10m_max=hist.wind.tolist(), surface_pressure_mean=hist.surface_pressure_mean.tolist(),
    )
    got = storm_features(req, model("storm")["cells"]["Puri"])
    for name in A.STORM_FEATURES:
        assert np.isclose(got[name], row[name], rtol=1e-6, atol=1e-6), name
