"""Model 6 features: how far a business's monthly revenue is from its own
pattern (plan section 6.3). Every feature uses the current and past months
only. Training and the service both call panel_features, so they agree.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

MIN_HISTORY_MONTHS = 13
# Floors so a very steady business does not turn a small dip into a huge z
MIN_STD = 0.05
DEFAULT_STD = 0.15
ANOMALY_FEATURES = ["seasonal_z", "yoy", "z12", "mom", "drawdown6", "months_below_median", "late_3m"]
# Baseline rule (plan section 6.4)
RULE_Z = -2.5
RULE_MONTHS = 2
# Peer rule: a cell where this share is anomalous in a month had a shared shock.
# -1.0 was picked on the 2016-2019 synthetic years; -2.0 recognised only half
# the shared shocks, because low-sensitivity neighbours barely move
PEER_Z = -1.0
SYSTEMIC_SHARE = 0.30


def run_length(flag: pd.DataFrame) -> pd.DataFrame:
    """Consecutive True months ending at each month."""
    c = flag.astype(int).cumsum()
    return (c - c.where(~flag).ffill().fillna(0)).astype(int)


def panel_features(revenue: pd.DataFrame, late: pd.DataFrame | None = None) -> dict[str, pd.DataFrame]:
    """`revenue` is months (rows, oldest first) by businesses (columns)."""
    lr = np.log(revenue.clip(lower=1.0))
    past = lr.shift(1)
    mean12 = past.rolling(12, min_periods=6).mean()
    std12 = past.rolling(12, min_periods=6).std().clip(lower=MIN_STD)
    # same month last year removes the seasonal shape without knowing the sector
    yoy = lr - lr.shift(12)
    yoy_past = yoy.shift(1)
    expected = yoy_past.rolling(12, min_periods=3).median().fillna(0.0)
    spread = yoy_past.rolling(12, min_periods=3).std().clip(lower=MIN_STD).fillna(DEFAULT_STD)
    late = late.astype(float) if late is not None else lr * 0.0
    return {
        "seasonal_z": (yoy - expected) / spread,
        "yoy": yoy,
        "z12": (lr - mean12) / std12,
        "mom": lr - past,
        "drawdown6": lr - past.rolling(6, min_periods=3).max(),
        "months_below_median": run_length(lr < past.rolling(12, min_periods=6).median()),
        "late_3m": late.rolling(3, min_periods=1).sum(),
    }


def rule_flags(seasonal_z: pd.DataFrame) -> pd.DataFrame:
    return run_length(seasonal_z < RULE_Z) >= RULE_MONTHS


def to_long(features: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """One row per business-month that has a year of history."""
    long = pd.concat({k: v.stack(future_stack=True) for k, v in features.items()}, axis=1)
    long.index.names = ["month", "business_id"]
    return long.dropna(subset=["yoy", "z12", "drawdown6"]).fillna(0.0)
