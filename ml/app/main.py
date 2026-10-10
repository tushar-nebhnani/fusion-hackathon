"""ML scoring service.

    POST /alerts/calibrate        model 4: chance a fired flood or storm alert is real
    POST /anomaly                 model 6: is a business's revenue breaking from its own pattern
    POST /risk/climate-cashflow   cash-flow simulation: climate's effect on default risk

    cd ml && .venv-data/bin/uvicorn app.main:app --port 8001

The monitor should call this after a rule fires and send the alert exactly
as today when the call fails or returns `band: "unscored"` (fail open), so
the model can never silence a warning.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
from datetime import date as Date
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from features.anomaly import ANOMALY_FEATURES, MIN_HISTORY_MONTHS, SYSTEMIC_SHARE, panel_features, rule_flags, run_length
from pydantic import BaseModel, Field
from risk.assumptions import ASSET_DAMAGE, DROUGHT_MONTH_LOSS, EVENT_REACH, HAZARDS, LGD
from risk.cashflow_sim import Business, simulate

MODELS = Path(__file__).resolve().parents[1] / "models"
DATA = Path(__file__).resolve().parents[1] / "data"
# A cell further than this from the point has climatology that does not apply
MAX_CELL_DISTANCE_KM = 150
IMD_HEAVY_MM = 64.5

app = FastAPI(title="ClimaCredit ML", version="0.1.0")
_models: dict[str, dict] = {}


def pinned(path: Path) -> bool:
    """joblib.load unpickles, which runs code, so only a file whose SHA-256 is
    committed in models/checksums.json (written by the training script) is
    loaded. Anything else is treated as missing: the alert goes out unscored."""
    try:
        sums = json.loads((MODELS / "checksums.json").read_text())
    except (OSError, ValueError):
        return False
    expected = sums.get(path.name)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    return isinstance(expected, str) and hmac.compare_digest(expected, actual)


def model(hazard: str) -> dict | None:
    if hazard not in _models:
        path = MODELS / ("cashflow_anomaly.joblib" if hazard == "anomaly" else f"alert_calibration_{hazard}.joblib")
        if not path.exists():
            return None
        if not pinned(path):
            logging.getLogger("ml").error("refusing %s: its SHA-256 is not the one in checksums.json", path.name)
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
    # Storm only, and both are needed: without them storm stays rule-only
    wind_speed_10m_max: list[float] | None = None
    surface_pressure_mean: list[float] | None = None


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


def storm_features(req: CalibrateRequest, c: dict) -> dict:
    rain = np.array(req.precipitation_sum, dtype=float)
    month, doy = req.date.month, req.date.timetuple().tm_yday
    wind = req.wind_speed_10m_max[-1]
    rh = req.relative_humidity_2m_mean[-1] if req.relative_humidity_2m_mean else c["rh_clim"][month]
    return {
        "rain": rain[-1],
        "rain_over_p99": rain[-1] / c["rain_p99"],
        "rain3": rain[-3:].sum(),
        "wind": wind,
        "wind_over_p99": wind / c["wind_p99"],
        "pressure_anom": req.surface_pressure_mean[-1] - c["pressure_clim"][month],
        "rh": rh,
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "post_monsoon": int(10 <= month <= 12),
        "trip_wind": int(wind >= c["wind_p99"]),
        "trip_rain": int(rain[-1] >= c["rain_p99"]),
    }


def calibrated(m: dict, x: pd.DataFrame) -> float:
    """Platt scaling, the same formula as platt() in training."""
    raw = min(max(float(m["model"].predict_proba(x)[:, 1][0]), 1e-6), 1 - 1e-6)
    z = m["platt"]["a"] * math.log(raw / (1 - raw)) + m["platt"]["b"]
    return 1 / (1 + math.exp(-z))


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "models": {h: model(h) is not None for h in ("flood", "storm", "anomaly")},
            "hazard_params": (DATA / "hazard_params.csv").exists()}


@app.post("/alerts/calibrate", response_model=CalibrateResponse)
def calibrate(req: CalibrateRequest) -> CalibrateResponse:
    if req.hazard == "storm" and not (req.wind_speed_10m_max and req.surface_pressure_mean):
        return CalibrateResponse(p_event=None, band="baseline", model_version="rule-only",
                                 reason="storm calibration needs wind_speed_10m_max and surface_pressure_mean")
    m = model(req.hazard)
    if m is None:
        return CalibrateResponse(p_event=None, band="unscored", model_version="none",
                                 reason="model file missing")
    cell, km = nearest(m["cells"], req.lat, req.lon)
    if km > MAX_CELL_DISTANCE_KM:
        return CalibrateResponse(p_event=None, band="unscored", model_version=m["model_version"],
                                 cell=cell, distance_km=round(km, 1),
                                 reason=f"no trained cell within {MAX_CELL_DISTANCE_KM} km")
    features = storm_features if req.hazard == "storm" else flood_features
    p = calibrated(m, pd.DataFrame([features(req, m["cells"][cell])])[m["features"]])
    bands = m["bands"]
    band = "high" if p >= bands["high"] else "low" if p < bands["low"] else "medium"
    return CalibrateResponse(p_event=round(p, 4), band=band, model_version=m["model_version"],
                             cell=cell, distance_km=round(km, 1))


class AnomalyRequest(BaseModel):
    # Monthly revenue ending on the latest month, oldest first
    monthly_revenue: list[float] = Field(min_length=MIN_HISTORY_MONTHS, max_length=120)
    late_payments: list[bool] | None = None
    # Share of businesses in the same cell that are anomalous this month, if the caller knows it
    cell_anomalous_share: float | None = Field(default=None, ge=0, le=1)
    climate_event_in_cell: bool | None = None


class AnomalyResponse(BaseModel):
    anomaly_score: float | None
    flagged: bool
    type: Literal["systemic", "idiosyncratic"] | None = None
    months_flagged: int
    model_version: str
    reason: str | None = None


@app.post("/anomaly", response_model=AnomalyResponse)
def anomaly(req: AnomalyRequest) -> AnomalyResponse:
    if req.late_payments is not None and len(req.late_payments) != len(req.monthly_revenue):
        raise HTTPException(status_code=422, detail="late_payments must be as long as monthly_revenue")
    m = model("anomaly")
    if m is None:
        return AnomalyResponse(anomaly_score=None, flagged=False, months_flagged=0, model_version="none",
                               reason="model file missing")
    revenue = pd.DataFrame({"b": req.monthly_revenue})
    late = pd.DataFrame({"b": req.late_payments}) if req.late_payments is not None else None
    f = panel_features(revenue, late)
    x = pd.DataFrame({k: f[k]["b"] for k in ANOMALY_FEATURES}).fillna(0.0)
    if m["method"] == "isolation_forest":
        score = pd.Series(-m["model"].score_samples(x[m["features"]]), index=x.index)
        flags = (score > m["threshold"]) & (f["seasonal_z"]["b"] < 0)
    else:
        score = -f["seasonal_z"]["b"].fillna(0.0)
        flags = rule_flags(f["seasonal_z"])["b"]
    # months without a year of history cannot be judged
    flags = flags & f["yoy"]["b"].notna()
    flagged = bool(flags.iloc[-1])
    kind = None
    if flagged:
        shared = (req.cell_anomalous_share >= SYSTEMIC_SHARE if req.cell_anomalous_share is not None
                  else bool(req.climate_event_in_cell))
        kind = "systemic" if shared else "idiosyncratic"
    return AnomalyResponse(anomaly_score=round(float(score.iloc[-1]), 4), flagged=flagged, type=kind,
                           months_flagged=int(run_length(flags.to_frame("b"))["b"].iloc[-1]),
                           model_version=m["model_version"])


_tables: dict[str, dict] = {}


def hazard_table() -> dict:
    """cell -> {lat, lon, hazards: {hazard: {events_per_year, mean_duration}}}, from hazard_params.py."""
    if "hazards" not in _tables:
        path = DATA / "hazard_params.csv"
        if not path.exists():
            return {}
        hp, spine = pd.read_csv(path), pd.read_csv(DATA / "spine.csv").set_index("location_name")
        _tables["hazards"] = {
            cell: {"lat": float(spine.cell_lat[cell]), "lon": float(spine.cell_lon[cell]),
                   "hazards": {r.hazard: {"events_per_year": r.events_per_year, "mean_duration": r.mean_duration}
                               for r in g.itertuples()}}
            for cell, g in hp.groupby("location_name")}
    return _tables["hazards"]


def sector_vulnerability() -> dict:
    """sector -> {hazard: 0-1}: the sector defaults the synthetic population was built with."""
    if "sectors" not in _tables:
        pop = pd.read_csv(DATA / "synthetic_businesses.csv", comment="#").drop_duplicates("sector").set_index("sector")
        _tables["sectors"] = {s: {h: float(r[f"sens_{h}"]) for h in HAZARDS} for s, r in pop.iterrows()}
    return _tables["sectors"]


class CashflowRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    monthly_revenue: float = Field(gt=0)
    variable_cost_share: float = Field(ge=0, le=0.95)
    fixed_costs: float = Field(ge=0)
    emi: float = Field(ge=0)
    starting_cash: float = Field(ge=0)
    revenue_volatility: float = Field(default=0.2, ge=0, le=1)
    sector: str | None = None
    # 0-1 per hazard; without it the sector's defaults are used
    vulnerability: dict[Literal["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"], float] | None = None
    insurance_recovery: float = Field(default=0.0, ge=0, le=1)
    backup_power: bool = False
    date: Date | None = None
    # The scorecard's base PD, to report a climate-adjusted PD beside it
    pd_base: float | None = Field(default=None, ge=0, le=1)
    # An active alert: model 4's probability replaces the first month's rate
    alert_hazard: Literal["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"] | None = None
    alert_p_event: float | None = Field(default=None, ge=0, le=1)


@app.post("/risk/climate-cashflow")
def climate_cashflow(req: CashflowRequest) -> dict:
    cells = hazard_table()
    if not cells:
        return {"scored": False, "reason": "hazard_params.csv missing; run risk/hazard_params.py"}
    vulnerability = req.vulnerability or sector_vulnerability().get(req.sector or "")
    if vulnerability is None:
        raise HTTPException(status_code=422, detail="send vulnerability, or a sector with defaults")
    if any(not 0 <= v <= 1 for v in vulnerability.values()):
        raise HTTPException(status_code=422, detail="vulnerability values must be between 0 and 1")
    if (req.alert_hazard is None) != (req.alert_p_event is None):
        raise HTTPException(status_code=422, detail="alert_hazard and alert_p_event go together")
    cell, km = nearest(cells, req.lat, req.lon)
    if km > MAX_CELL_DISTANCE_KM:
        return {"scored": False, "cell": cell, "distance_km": round(km, 1),
                "reason": f"no cell with measured hazards within {MAX_CELL_DISTANCE_KM} km"}
    business = Business(
        monthly_revenue=req.monthly_revenue, variable_cost_share=req.variable_cost_share, fixed_costs=req.fixed_costs,
        emi=req.emi, starting_cash=req.starting_cash, revenue_volatility=req.revenue_volatility,
        vulnerability=dict(vulnerability), insurance_recovery=req.insurance_recovery, backup_power=req.backup_power,
        sector=req.sector)
    alert = {"hazard": req.alert_hazard, "p_event": req.alert_p_event} if req.alert_hazard else None
    hazards = cells[cell]["hazards"]
    out = simulate(business, hazards, start_month=(req.date or Date.today()).month, alert=alert, pd_base=req.pd_base)
    return {
        "scored": True, "cell": cell, "distance_km": round(km, 1), **out,
        "hazards": hazards,
        "assumptions": [
            "The base default rate of this cash model is not calibrated to real defaults; only the climate difference is meaningful.",
            f"Loss given default {LGD:.0%}.",
            f"Asset damage per event, share of monthly revenue at vulnerability 1: {ASSET_DAMAGE} (assumed).",
            f"Share of recorded events that reach one business: {EVENT_REACH} (assumed).",
            f"A dry month costs {DROUGHT_MONTH_LOSS:.0%} of margin at vulnerability 1 (assumed).",
            "Event rates and durations are measured from 1995-2023 weather, IFI floods and IBTrACS storms for the cell.",
            "Vulnerability comes from the request, or from assumed sector defaults.",
        ],
    }
