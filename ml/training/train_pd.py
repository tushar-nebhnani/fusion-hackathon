"""Train model 5, the phase 2 credit PD pipeline, on synthetic loans (plan section 5).

    python ml/training/train_pd.py

It cannot set the live score: the labels are ours. It shows the pipeline
runs end to end, that it finds the climate multiplier we planted at about
the right size, and that the same loans come out riskiest whatever
multiplier is assumed. Writes ml/models/pd_phase2_m{10,15,20}.joblib and
pd_phase2_metrics.json. Not served.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score, roc_curve
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML / "features"))
import build_pd as G  # noqa: E402

MODELS = ML / "models"
MODEL_VERSION = "pd-phase2-0.1.0"
SEED = 0
# Cells held out entirely, so the model is tested on places it has not seen
TEST_SHARE = 0.25
BOOTSTRAPS = 40


def logistic():
    pre = ColumnTransformer([("num", StandardScaler(), G.NUMERIC),
                             ("cat", OneHotEncoder(handle_unknown="ignore"), G.CATEGORICAL)])
    return make_pipeline(pre, LogisticRegression(C=10.0, max_iter=2000))


def boosted(categories: int):
    pre = ColumnTransformer([("num", "passthrough", G.NUMERIC),
                             ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), G.CATEGORICAL)])
    mono = [G.MONOTONIC.get(f, 0) for f in G.NUMERIC] + [0] * categories
    return make_pipeline(pre, HistGradientBoostingClassifier(
        max_depth=3, learning_rate=0.05, max_iter=300, l2_regularization=1.0,
        monotonic_cst=mono, random_state=SEED))


def scores(y: np.ndarray, p: np.ndarray) -> dict:
    fpr, tpr, _ = roc_curve(y, p)
    return {"auc": round(float(roc_auc_score(y, p)), 4), "ks": round(float((tpr - fpr).max()), 4),
            "brier": round(float(brier_score_loss(y, p)), 5)}


def shock_coefficient(model, train: pd.DataFrame) -> float:
    """The logistic's coefficient on climate_shock in the feature's own units; the label used log(m)."""
    i = G.NUMERIC.index("climate_shock")
    return float(model[-1].coef_[0][i] / model[0].named_transformers_["num"].scale_[i])


def recovery(train: pd.DataFrame, m: float) -> dict:
    rng = np.random.default_rng(SEED)
    cells = train.location_name.unique()
    by_cell = {c: g for c, g in train.groupby("location_name")}
    est = []
    for _ in range(BOOTSTRAPS):  # resample whole cells: loans in a cell share their shocks
        b = pd.concat([by_cell[c] for c in rng.choice(cells, len(cells))])
        est.append(shock_coefficient(logistic().fit(b, b.default_12m), b))
    lo, hi = np.quantile(est, [0.025, 0.975])
    planted = float(np.log(m))
    return {"planted_log_m": round(planted, 3), "estimate": round(float(np.median(est)), 3),
            "interval_95": [round(float(lo), 3), round(float(hi), 3)], "planted_inside_interval": bool(lo <= planted <= hi)}


def train_one(base: pd.DataFrame, m: float, split: tuple[np.ndarray, np.ndarray]) -> tuple[dict, dict, np.ndarray]:
    d = G.label(base, m)
    train, test = d.iloc[split[0]], d.iloc[split[1]]
    y = test.default_12m.values
    lr = logistic().fit(train, train.default_12m)
    categories = sum(len(c) for c in lr[0].named_transformers_["cat"].categories_)
    gb = boosted(categories).fit(train, train.default_12m)
    p_lr, p_gb = lr.predict_proba(test)[:, 1], gb.predict_proba(test)[:, 1]
    by_size = train.groupby("size").default_12m.mean()

    # How much the ranking on unseen cells loses when the climate columns are shuffled
    rng = np.random.default_rng(SEED)
    shuffled = test.copy()
    shuffled[G.CLIMATE] = shuffled[G.CLIMATE].values[rng.permutation(len(test))]
    high = test.climate_shock >= test.climate_shock[test.climate_shock > 0].quantile(0.75)
    calm = (test.climate_shock == 0) & (test.combined_exposure >= test.combined_exposure.median())

    def ratio(p: np.ndarray) -> float:
        return round(float(p[high.values].mean() / p[calm.values].mean()), 3)

    metrics = {
        "multiplier": m,
        "loans": {"train": len(train), "test": len(test), "test_cells": int(test.location_name.nunique()),
                  "train_default_rate": round(float(train.default_12m.mean()), 4),
                  "test_default_rate": round(float(y.mean()), 4)},
        "baseline_rate_by_size": scores(y, test["size"].map(by_size).values),
        "logistic": scores(y, p_lr),
        "boosted_monotonic": scores(y, p_gb),
        "ceiling_true_pd": scores(y, test.true_pd.values),
        "recovery": recovery(train, m),
        "auc_lost_without_climate": {"logistic": round(scores(y, p_lr)["auc"] - scores(y, lr.predict_proba(shuffled)[:, 1])["auc"], 4),
                                     "boosted_monotonic": round(scores(y, p_gb)["auc"] - scores(y, gb.predict_proba(shuffled)[:, 1])["auc"], 4)},
        "pd_ratio_shocked_vs_calm": {"truth": ratio(test.true_pd.values), "logistic": ratio(p_lr), "boosted_monotonic": ratio(p_gb)},
    }
    best = "logistic" if metrics["logistic"]["brier"] <= metrics["boosted_monotonic"]["brier"] else "boosted_monotonic"
    metrics["kept"] = best
    artifact = {"model": lr if best == "logistic" else gb, "kind": best, "numeric": G.NUMERIC, "categorical": G.CATEGORICAL,
                "multiplier": m, "model_version": MODEL_VERSION, "synthetic": True}
    return artifact, metrics, p_lr


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    base = G.base_loans()
    split = next(GroupShuffleSplit(1, test_size=TEST_SHARE, random_state=SEED).split(base, groups=base.location_name))
    results, preds = [], {}
    for m in G.MULTIPLIERS:
        artifact, metrics, p = train_one(base, m, split)
        joblib.dump(artifact, MODELS / f"pd_phase2_m{int(m * 10)}.joblib", compress=3)
        results.append(metrics)
        preds[m] = p
    report = {
        "model_version": MODEL_VERSION, "data": "synthetic loans and labels; calibration targets not verified",
        "by_multiplier": results,
        # the same test loans under each assumed multiplier, logistic scores: do the same ones come out riskiest?
        "rank_agreement_spearman": {f"m{a}_vs_m{b}": round(float(spearmanr(preds[a], preds[b])[0]), 4)
                                    for a, b in ((1.0, 1.5), (1.0, 2.0), (1.5, 2.0))},
    }
    (MODELS / "pd_phase2_metrics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
