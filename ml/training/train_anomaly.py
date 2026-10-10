"""Train model 6, cash-flow anomaly detection (plan section 6).

    python ml/training/train_anomaly.py

Fits on synthetic 2015-2019 series, scores 2020-2023, and compares an
IsolationForest with the plain rule. Writes ml/models/cashflow_anomaly.joblib
and cashflow_anomaly_metrics.json. The detector is only shown to find the
shocks we injected; that says nothing about how often real businesses do this.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML / "features"))
import anomaly as F  # noqa: E402
import build_monthly as G  # noqa: E402
from checksums import pin  # noqa: E402

MODELS = ML / "models"
MODEL_VERSION = "cashflow-anomaly-0.1.0"
FIT_UNTIL = 2019
SEED = 0
# The bank reviews this many businesses a month
TOP_K = 20
# A shock counts as caught if flagged within this many months of its start
CATCH_WITHIN_MONTHS = 3


def evaluate(flag: pd.DataFrame, score: pd.DataFrame, g: dict, test: pd.Index) -> dict:
    """`flag` and `score` are months x businesses; a higher score is more anomalous."""
    drop = 1 - (1 - g["drop_systemic"]) * (1 - g["drop_idiosyncratic"])
    shocked = (drop >= G.SHOCK_DROP).loc[test]
    f, s = flag.loc[test], score.loc[test]
    top = s.rank(axis=1, ascending=False, method="first") <= TOP_K
    out = {
        "flagged_share": round(float(f.values.mean()), 4),
        "precision": round(float(shocked.values[f.values].mean()) if f.values.any() else 0.0, 3),
        f"precision_at_{TOP_K}": round(float(shocked.values[top.values].mean()), 3),
    }
    for kind in ("systemic", "idiosyncratic"):
        onset = g[f"onset_{kind}"].loc[test]
        if kind == "idiosyncratic":
            onset = onset & (g["drop_idiosyncratic"].loc[test] >= G.SHOCK_DROP)
        lags = []
        for month, biz in zip(*np.nonzero(onset.values)):
            window = f.values[month:month + CATCH_WITHIN_MONTHS + 1, biz]
            lags.append(int(np.argmax(window)) if window.any() else None)
        caught = [x for x in lags if x is not None]
        out[kind] = {"shocks": len(lags), "recall": round(len(caught) / max(len(lags), 1), 3),
                     "mean_lag_months": round(float(np.mean(caught)), 2) if caught else None}
    return out


def split_accuracy(flag: pd.DataFrame, seasonal_z: pd.DataFrame, g: dict, test: pd.Index) -> dict:
    """The peer rule: a flagged month is systemic when enough of the cell is
    anomalous in the same month. Scored on flagged months that are real shocks."""
    cell = g["population"].set_index("business_id").location_name
    low = (seasonal_z < F.PEER_Z).loc[test]
    share = low.T.groupby(cell).transform("mean").T
    said_systemic = share >= F.SYSTEMIC_SHARE
    sys_drop, idio_drop = g["drop_systemic"].loc[test], g["drop_idiosyncratic"].loc[test]
    real = flag.loc[test] & ((sys_drop >= G.SHOCK_DROP) | (idio_drop >= G.SHOCK_DROP))
    truth_systemic = sys_drop >= idio_drop
    right = (said_systemic == truth_systemic).values[real.values]
    ts, ss = truth_systemic.values[real.values], said_systemic.values[real.values]
    return {
        "flagged_real_shock_months": int(real.values.sum()),
        "accuracy": round(float(right.mean()), 3),
        # always answering "systemic" scores 0.5 here
        "balanced_accuracy": round(float((ss[ts].mean() + (~ss[~ts]).mean()) / 2), 3) if ts.any() and (~ts).any() else None,
        "systemic_recognised": round(float(ss[ts].mean()), 3) if ts.any() else None,
        "business_only_recognised": round(float((~ss[~ts]).mean()), 3) if (~ts).any() else None,
        "always_systemic_accuracy": round(float(ts.mean()), 3),
    }


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    g = G.generate()
    feats = F.panel_features(g["revenue"], g["late"])
    long = F.to_long(feats)
    year = long.index.get_level_values("month").year
    fit, months = long[year <= FIT_UNTIL], g["revenue"].index
    test = months[months.year > FIT_UNTIL]

    drop = 1 - (1 - g["drop_systemic"]) * (1 - g["drop_idiosyncratic"])
    shock_rate = float((drop >= G.SHOCK_DROP).loc[months[months.year <= FIT_UNTIL]].values.mean())
    forest = IsolationForest(n_estimators=200, contamination=min(shock_rate, 0.5), random_state=SEED)
    forest.fit(fit[F.ANOMALY_FEATURES])

    score = pd.Series(-forest.score_samples(long[F.ANOMALY_FEATURES]), index=long.index).unstack("business_id")
    score = score.reindex(index=months, columns=g["revenue"].columns)
    threshold = float(-forest.offset_)
    # IsolationForest also flags unusually good months; only drops matter here
    forest_flag = (score > threshold) & (feats["seasonal_z"] < 0)
    rule_flag = F.rule_flags(feats["seasonal_z"])
    rule_score = -feats["seasonal_z"].fillna(0.0)

    results = {
        "model_version": MODEL_VERSION,
        "data": "synthetic; shocks injected on real flood and storm dates",
        "businesses": int(g["revenue"].shape[1]),
        "fit_years": f"{months[0].year}-{FIT_UNTIL}", "test_years": f"{FIT_UNTIL + 1}-{months[-1].year}",
        "shock_rate_in_fit_years": round(shock_rate, 4),
        "rule": evaluate(rule_flag, rule_score, g, test),
        "isolation_forest": evaluate(forest_flag, score.fillna(-np.inf), g, test),
    }
    r, f = results["rule"], results["isolation_forest"]
    # Ship the forest only if it catches more of both kinds without being less precise
    better = (f["systemic"]["recall"] > r["systemic"]["recall"]
              and f["idiosyncratic"]["recall"] > r["idiosyncratic"]["recall"]
              and f[f"precision_at_{TOP_K}"] >= r[f"precision_at_{TOP_K}"] - 0.02)
    method = "isolation_forest" if better else "rule"
    results["shipped"] = method
    results["systemic_split"] = split_accuracy(forest_flag if better else rule_flag, feats["seasonal_z"], g, test)

    joblib.dump({"method": method, "model": forest if better else None, "threshold": threshold,
                 "features": F.ANOMALY_FEATURES, "model_version": MODEL_VERSION},
                MODELS / "cashflow_anomaly.joblib", compress=3)
    # The service loads it only with a matching hash (checksums.py)
    pin(MODELS / "cashflow_anomaly.joblib")
    (MODELS / "cashflow_anomaly_metrics.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
