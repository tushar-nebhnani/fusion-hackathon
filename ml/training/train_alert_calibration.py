"""Train model 4, alert calibration (plan section 4).

    python ml/training/train_alert_calibration.py

Writes ml/models/alert_calibration_<hazard>.joblib (or baseline-only when a
hazard has fewer than MIN_TRAIN_HITS), metrics JSON and reliability plots.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import average_precision_score, brier_score_loss  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML / "features"))
import alerts as A  # noqa: E402
from checksums import pin  # noqa: E402

MODELS = ML / "models"
FIG = ML / "eda" / "figures"
MODEL_VERSION = "alert-cal-0.2.0"
# Plan section 4.4 said 50. Lowered so storm (30 hits) trains: on 2020-2023 a
# plain logistic ranks storms far above the rule, though on 16 real events
MIN_TRAIN_HITS = 25
# Operating points chosen on validation: share of real events an alert band keeps
KEEP_HITS_LOW = 0.90   # below this score: bank-only / log
KEEP_HITS_HIGH = 0.50  # above this score: high band


def baseline_rate(train: pd.DataFrame) -> dict[int, float]:
    """The rule alone: one probability per alert, by coastal/inland."""
    return train.groupby("coastal").label.mean().to_dict()


def baseline_predict(rates: dict[int, float], df: pd.DataFrame) -> np.ndarray:
    return df.coastal.map(rates).fillna(np.mean(list(rates.values()))).values


def threshold_keeping(y: np.ndarray, p: np.ndarray, keep: float) -> float:
    """Highest score threshold that still keeps `keep` of the real events."""
    hits = np.sort(p[y == 1])[::-1]
    if len(hits) == 0:
        return 0.0
    return float(hits[max(0, int(np.ceil(keep * len(hits))) - 1)])


def at_threshold(y: np.ndarray, p: np.ndarray, t: float) -> dict:
    sent = p >= t
    hits = int(y.sum())
    false = int((y == 0).sum())
    return {
        "threshold": round(t, 4),
        "hits_kept": round(float((sent & (y == 1)).sum() / max(hits, 1)), 3),
        "false_alarms_cut": round(float((~sent & (y == 0)).sum() / max(false, 1)), 3),
        "precision": round(float(y[sent].mean()) if sent.any() else 0.0, 3),
    }


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def fit_platt(raw: np.ndarray, y: np.ndarray) -> dict[str, float]:
    """Platt scaling on validation. Isotonic gave the test alerts only 28
    distinct scores, which lost ranking (PR-AUC 0.170 against 0.198)."""
    m = LogisticRegression(C=1e6, max_iter=1000).fit(logit(raw).reshape(-1, 1), y)
    return {"a": float(m.coef_[0][0]), "b": float(m.intercept_[0])}


def platt(raw: np.ndarray, cal: dict[str, float]) -> np.ndarray:
    # app/main.py applies the same formula when serving
    return 1 / (1 + np.exp(-(cal["a"] * logit(raw) + cal["b"])))


def fit_model(kind: str, X: pd.DataFrame, y: pd.Series):
    if kind == "logistic":
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=5000))
    else:
        m = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=300,
                                           l2_regularization=1.0, random_state=0)
    return m.fit(X, y)


def evaluate(name: str, eps: pd.DataFrame, features: list[str], cells: dict) -> dict:
    s = A.split(eps)
    train, val, test = s["train"], s["val"], s["test"]
    rates = baseline_rate(train)
    out: dict = {
        "hazard": name,
        "counts": {k: {"episodes": len(d), "hits": int(d.label.sum()), "rate": round(d.label.mean(), 4)}
                   for k, d in s.items()},
    }
    if train.label.sum() < MIN_TRAIN_HITS:
        p = baseline_predict(rates, test)
        out["status"] = f"baseline only: {int(train.label.sum())} training hits < {MIN_TRAIN_HITS}"
        out["baseline_rates"] = {str(k): round(v, 4) for k, v in rates.items()}
        out["test"] = {"baseline_brier": round(brier_score_loss(test.label, p), 4),
                       "base_rate": round(test.label.mean(), 4)}
        return out

    # Pick the model family on validation PR-AUC
    cands = {k: fit_model(k, train[features], train.label) for k in ("logistic", "gbm")}
    val_ap = {k: average_precision_score(val.label, m.predict_proba(val[features])[:, 1])
              for k, m in cands.items()}
    kind = max(val_ap, key=val_ap.get)
    model = cands[kind]
    cal = fit_platt(model.predict_proba(val[features])[:, 1], val.label.values)

    def predict(df: pd.DataFrame) -> np.ndarray:
        return platt(model.predict_proba(df[features])[:, 1], cal)

    p_val, p_test = predict(val), predict(test)
    t_low = threshold_keeping(val.label.values, p_val, KEEP_HITS_LOW)
    t_high = threshold_keeping(val.label.values, p_val, KEEP_HITS_HIGH)
    b_test = baseline_predict(rates, test)
    y = test.label.values
    out.update({
        "status": "model",
        "model_version": MODEL_VERSION,
        "model_kind": kind,
        "val_pr_auc": {k: round(v, 4) for k, v in val_ap.items()},
        "test": {
            "base_rate": round(y.mean(), 4),
            "pr_auc": round(average_precision_score(y, p_test), 4),
            "baseline_pr_auc": round(average_precision_score(y, b_test), 4),
            "brier": round(brier_score_loss(y, p_test), 4),
            "baseline_brier": round(brier_score_loss(y, b_test), 4),
            "low_band_cut": at_threshold(y, p_test, t_low),
            "high_band": at_threshold(y, p_test, t_high),
        },
        "per_year_test_base_rate": test.groupby(test.start.dt.year).label.mean().round(3).to_dict(),
    })
    if kind == "logistic":
        coefs = model[-1].coef_[0]
        out["coefficients_std"] = dict(sorted(zip(features, np.round(coefs, 3)), key=lambda x: -abs(x[1])))

    out["leave_one_region_out"] = loro(eps, features, kind)
    reliability(name, y, p_test, b_test)
    saved = MODELS / f"alert_calibration_{name}.joblib"
    joblib.dump({
        "model": model, "platt": cal, "features": features, "bands": {"low": t_low, "high": t_high},
        "baseline_rates": rates, "model_version": MODEL_VERSION, "hazard": name, "cells": cells,
    }, saved, compress=3)
    pin(saved)
    return out



def loro(eps: pd.DataFrame, features: list[str], kind: str) -> dict:
    """Train on all other regions (train years), test on the held-out region
    (val + test years): does it transfer to cells it has not seen?"""
    res = {}
    early = eps[A._in(A.TRAIN_YEARS, eps.start)]
    late = eps[eps.start.dt.year.between(A.VAL_YEARS[0], A.TEST_YEARS[1])]
    for region in sorted(eps.region.unique()):
        tr, te = early[early.region != region], late[late.region == region]
        if te.label.sum() < 5:
            res[region] = "too few hits to score"
            continue
        m = fit_model(kind, tr[features], tr.label)
        p = m.predict_proba(te[features])[:, 1]
        res[region] = {"hits": int(te.label.sum()), "base_rate": round(te.label.mean(), 3),
                       "pr_auc": round(average_precision_score(te.label, p), 3)}
    return res


def reliability(name: str, y: np.ndarray, p: np.ndarray, b: np.ndarray) -> None:
    bins = np.quantile(p, np.linspace(0, 1, 9))
    idx = np.clip(np.digitize(p, np.unique(bins)[1:-1]), 0, None)
    df = pd.DataFrame({"y": y, "p": p, "bin": idx}).groupby("bin").agg(p=("p", "mean"), y=("y", "mean"), n=("y", "size"))
    fig, ax = plt.subplots(figsize=(5, 5))
    ax.plot([0, 1], [0, 1], ls="--", c="grey", lw=1, label="perfect")
    ax.plot(df.p, df.y, marker="o", label="model 4 (calibrated)")  # few points when events are few
    ax.axhline(b.mean(), c="#c0504d", lw=1, label="rule alone (one rate)")
    top = max(df.p.max(), df.y.max()) * 1.15
    ax.set_xlim(0, top)
    ax.set_ylim(0, top)
    ax.set_xlabel(f"predicted P(real {name})")
    ax.set_ylabel("observed share that were real")
    ax.set_title(f"{name}: reliability on 2020-2023 (unseen)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIG / f"reliability_{name}.png", dpi=120)


def cell_stats(w: pd.DataFrame) -> dict:
    """Per-cell thresholds and monthly climatology, so serving computes the
    same features from a short recent series."""
    first = w.groupby("location_name").first()
    clim = w.groupby(["location_name", "month"]).first()[["rain30_clim", "soil_clim", "pressure_clim"]]
    clim["rh_clim"] = (w[A._in(A.TRAIN_YEARS, w.date)]
                       .groupby(["location_name", "month"]).rh.mean())
    out = {}
    for name, r in first.iterrows():
        out[name] = {
            "lat": float(r.cell_lat), "lon": float(r.cell_lon), "coastal": int(r.coastal),
            "rain_p99": float(r.rain_p99), "rain3_p95": float(r.rain3_p95), "wind_p99": float(r.wind_p99),
            "cell_flood_rate": float(r.cell_flood_rate),
            "rain30_clim": {int(m): float(v) for m, v in clim.loc[name].rain30_clim.items()},
            "soil_clim": {int(m): float(v) for m, v in clim.loc[name].soil_clim.items()},
            "rh_clim": {int(m): float(v) for m, v in clim.loc[name].rh_clim.items()},
            "pressure_clim": {int(m): float(v) for m, v in clim.loc[name].pressure_clim.items()},
        }
    return out


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    weather, spine, floods, storms = A.load()
    w = A.daily_features(weather, spine, floods)
    fe, fm = A.flood_dataset(w, floods)
    se, sm = A.storm_dataset(w, storms)
    results = []
    stats = cell_stats(w)
    for name, eps, miss, feats in (("flood", fe, fm, A.FLOOD_FEATURES), ("storm", se, sm, A.STORM_FEATURES)):
        eps = eps[eps.start.dt.year <= A.TEST_YEARS[1]]
        # storm episodes exist only in cells storms reach, so serving scores only those
        r = evaluate(name, eps, feats, {n: c for n, c in stats.items() if n in set(eps.location_name)})
        r["misses_no_alert"] = {"events": len(miss), "share": round(len(miss) / max(len(miss) + int(eps.label.sum()), 1), 3)}
        results.append(r)
    path = MODELS / "alert_calibration_metrics.json"
    path.write_text(json.dumps(results, indent=2, default=str))
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
