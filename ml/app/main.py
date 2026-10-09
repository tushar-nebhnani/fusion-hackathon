"""ML scoring service. Model 4: POST /alerts/calibrate.

    cd ml && .venv-data/bin/uvicorn app.main:app --port 8001

The monitor should call this after a rule fires and send the alert exactly
as today when the call fails or returns `band: "unscored"` (fail open), so
the model can never silence a warning.
"""

from __future__ import annotations

import math
from datetime import date as Date
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODELS = Path(__file__).resolve().parents[1] / "models"
# A cell further than this from the point has climatology that does not apply
MAX_CELL_DISTANCE_KM = 150
IMD_HEAVY_MM = 64.5

app = FastAPI(title="ClimaCredit ML", version="0.1.0")
_models: dict[str, dict] = {}


def model(hazard: str) -> dict | None:
    if hazard not in _models:
        path = MODELS / f"alert_calibration_{hazard}.joblib"
        if not path.exists():
            return None
        _models[hazard] = joblib.load(path)
    return _models[hazard]


class CalibrateRequest(BaseModel):
    hazard: Literal["flood", "storm"]
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    date: Date
    # Daily values ending on the alert day, oldest first
    precipitation_sum: list[float] = Field(min_length=1, max_length=60)
    soil_wetness_top: list[float] | None = None
    relative_humidity_2m_mean: list[float] | None = None


class CalibrateResponse(BaseModel):
    p_event: float | None
    band: Literal["low", "medium", "high", "baseline", "unscored"]
    model_version: str
    cell: str | None = None
    distance_km: float | None = None
    reason: str | None = None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(a))


def nearest(cells: dict, lat: float, lon: float) -> tuple[str, float]:
    return min(((n, haversine_km(lat, lon, c["lat"], c["lon"])) for n, c in cells.items()),
               key=lambda x: x[1])


def flood_features(req: CalibrateRequest, c: dict) -> dict:
    rain = np.array(req.precipitation_sum, dtype=float)
    month, doy = req.date.month, req.date.timetuple().tm_yday
    soil = req.soil_wetness_top[-1] if req.soil_wetness_top else c["soil_clim"][month]
    rh = req.relative_humidity_2m_mean[-1] if req.relative_humidity_2m_mean else c["rh_clim"][month]
    rain3 = rain[-3:].sum()
    return {
        "rain": rain[-1],
        "rain_over_p99": rain[-1] / c["rain_p99"],
        "rain3": rain3,
        "rain3_over_p95": rain3 / c["rain3_p95"],
        "rain7": rain[-7:].sum(),
        "rain14": rain[-14:].sum(),
        "wet_days7": float((rain[-7:] >= 10).sum()),
        # a series shorter than 30 days understates this; the model sees it as drier
        "rain30_anom": rain[-30:].sum() - c["rain30_clim"][month],
        "soil": soil,
        "soil_anom": soil - c["soil_clim"][month],
        "rh": rh,
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "monsoon": int(6 <= month <= 9),
        "coastal": c["coastal"],
        "cell_flood_rate": c["cell_flood_rate"],
        "trip_imd": int(rain[-1] >= IMD_HEAVY_MM),
        "trip_rel": int(rain3 >= c["rain3_p95"]),
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "models": {h: model(h) is not None for h in ("flood",)}}


@app.post("/alerts/calibrate", response_model=CalibrateResponse)
def calibrate(req: CalibrateRequest) -> CalibrateResponse:
    if req.hazard == "storm":
        # Fewer than 50 training hits: the plan ships the rule's base rate only
        return CalibrateResponse(p_event=None, band="baseline", model_version="rule-only",
                                 reason="storm calibration has too few real events to train")
    m = model("flood")
    if m is None:
        return CalibrateResponse(p_event=None, band="unscored", model_version="none",
                                 reason="model file missing")
    cell, km = nearest(m["cells"], req.lat, req.lon)
    if km > MAX_CELL_DISTANCE_KM:
        return CalibrateResponse(p_event=None, band="unscored", model_version=m["model_version"],
                                 cell=cell, distance_km=round(km, 1),
                                 reason=f"no trained cell within {MAX_CELL_DISTANCE_KM} km")
    x = pd.DataFrame([flood_features(req, m["cells"][cell])])[m["features"]]
    p = float(m["isotonic"].predict(m["model"].predict_proba(x)[:, 1])[0])
    bands = m["bands"]
    band = "high" if p >= bands["high"] else "low" if p < bands["low"] else "medium"
    return CalibrateResponse(p_event=round(p, 4), band=band, model_version=m["model_version"],
                             cell=cell, distance_km=round(km, 1))
