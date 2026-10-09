"""Monte Carlo cash-flow simulation: how much more often a business falls 90
days behind on its EMI because of weather (risk plan sections 3 and 4).

The same random draws are used with and without climate, so the difference
is low-noise. Only the difference is meaningful: the base default rate of
this simple cash model is not calibrated to real defaults.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from .assumptions import (ASSET_DAMAGE, BACKUP_POWER_DAYS_SAVED, DEFAULT_MONTHS_OVERDUE, DROUGHT_MONTH_LOSS,
                          EVENT_REACH, HAZARDS, LGD, WHAT_IF_EXTRA_BUFFER_MONTHS, WHAT_IF_INSURANCE_RECOVERY,
                          season)

PATHS = 20_000
MONTHS = 12
DAYS_IN_MONTH = 30
# More than this many events of one hazard in a month is treated as this many
MAX_EVENTS_PER_MONTH = 3


@dataclass(frozen=True)
class Business:
    monthly_revenue: float
    variable_cost_share: float
    fixed_costs: float
    emi: float
    starting_cash: float
    revenue_volatility: float = 0.2
    # 0-1 share of revenue lost on a disrupted day, per hazard
    vulnerability: dict[str, float] = field(default_factory=dict)
    insurance_recovery: float = 0.0
    backup_power: bool = False
    sector: str | None = None


def draws(n: int, months: int, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    h = len(HAZARDS)
    return {
        "revenue": rng.standard_normal((n, months)),
        "events": rng.random((n, months, h)),
        "duration": rng.random((n, months, h, MAX_EVENTS_PER_MONTH)),
    }


def event_counts(u: np.ndarray, rate: float) -> np.ndarray:
    """Poisson count from a uniform draw, so a higher rate never gives fewer events."""
    p, cum, n = np.exp(-rate), 0.0, np.zeros(u.shape, dtype=int)
    for k in range(MAX_EVENTS_PER_MONTH):
        cum += p
        n += u > cum
        p *= rate / (k + 1)
    return n


def climate_loss(b: Business, hazards: dict, revenue: np.ndarray, d: dict, alert: dict | None) -> dict[str, np.ndarray]:
    """Monthly loss per hazard, before the cap on disrupted days."""
    margin = revenue * (1 - b.variable_cost_share)
    lost_days = np.zeros(revenue.shape)
    one_off: dict[str, np.ndarray] = {}
    per_day: dict[str, np.ndarray] = {}
    for i, hazard in enumerate(HAZARDS):
        v = b.vulnerability.get(hazard, 0.0)
        par = hazards.get(hazard)
        if not par or v <= 0:
            continue
        rate = par["events_per_year"] * EVENT_REACH[hazard] / 12
        u = d["events"][:, :, i]
        if hazard == "drought":
            # counted in dry months, not days
            dry = u > 1 - min(rate, 1.0)
            one_off[hazard] = dry * margin * v * DROUGHT_MONTH_LOSS
            continue
        n = event_counts(u, rate)
        if alert and alert["hazard"] == hazard:
            # model 4's calibrated probability replaces the first month's rate
            n[:, 0] = u[:, 0] > 1 - alert["p_event"]
        p = 1 / max(par["mean_duration"], 1.0)
        length = np.ceil(np.log1p(-d["duration"][:, :, i, :]) / np.log1p(-p)) if p < 1 else np.ones_like(d["duration"][:, :, i, :])
        days = (length * (np.arange(MAX_EVENTS_PER_MONTH) < n[:, :, None])).sum(axis=2)
        if b.backup_power:
            days = days * (1 - BACKUP_POWER_DAYS_SAVED.get(hazard, 0.0))
        per_day[hazard] = days * v
        lost_days += days * v
        one_off[hazard] = n * ASSET_DAMAGE[hazard] * v * b.monthly_revenue
    # a month cannot lose more than a month of margin to disrupted days
    scale = np.minimum(1.0, DAYS_IN_MONTH / np.maximum(lost_days, 1e-9))
    keep = 1 - b.insurance_recovery
    out = {h: x * keep for h, x in one_off.items()}
    for hazard, days in per_day.items():
        out[hazard] = out[hazard] + margin / DAYS_IN_MONTH * days * scale * keep
    return out


def run(b: Business, hazards: dict, d: dict, start_month: int = 1, alert: dict | None = None) -> dict:
    months = d["revenue"].shape[1]
    shape = np.array(season(b.sector))[(start_month - 1 + np.arange(months)) % 12]
    sigma = b.revenue_volatility
    revenue = b.monthly_revenue * shape * np.exp(sigma * d["revenue"] - sigma ** 2 / 2)
    by_hazard = climate_loss(b, hazards, revenue, d, alert)
    loss = sum(by_hazard.values()) if by_hazard else np.zeros(revenue.shape)
    income = revenue * (1 - b.variable_cost_share) - b.fixed_costs - b.emi

    def defaults(net: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        # Cash minus overdue EMIs. Below zero means an EMI is unpaid; three
        # months running is 90 days past due
        position = b.starting_cash + np.cumsum(net, axis=1)
        short = position < 0
        run_length = np.zeros(len(short), dtype=int)
        hit = np.zeros(len(short), dtype=bool)
        for t in range(months):
            run_length = np.where(short[:, t], run_length + 1, 0)
            hit |= run_length >= DEFAULT_MONTHS_OVERDUE
        return hit, short[:, 0]

    with_climate, short_with = defaults(income - loss)
    without, short_without = defaults(income)
    annual = loss.sum(axis=1)
    return {
        "pd_with": float(with_climate.mean()), "pd_without": float(without.mean()),
        "short_30d_with": float(short_with.mean()), "short_30d_without": float(short_without.mean()),
        "expected_loss": float(annual.mean()), "cfar95": float(np.quantile(annual, 0.95)),
        "loss_by_hazard": {h: float(x.sum(axis=1).mean()) for h, x in by_hazard.items()},
    }


def simulate(b: Business, hazards: dict, *, n: int = PATHS, months: int = MONTHS, seed: int = 0,
             start_month: int = 1, alert: dict | None = None, pd_base: float | None = None) -> dict:
    d = draws(n, months, seed)
    r = run(b, hazards, d, start_month, alert)
    delta = r["pd_with"] - r["pd_without"]
    extra = WHAT_IF_EXTRA_BUFFER_MONTHS * (b.fixed_costs + b.emi)
    levers = {
        f"insure {WHAT_IF_INSURANCE_RECOVERY:.0%} of climate losses":
            replace(b, insurance_recovery=max(b.insurance_recovery, WHAT_IF_INSURANCE_RECOVERY)),
        f"hold {WHAT_IF_EXTRA_BUFFER_MONTHS:g} more month of costs in cash":
            replace(b, starting_cash=b.starting_cash + extra),
        "install backup power": replace(b, backup_power=True),
    }
    what_if = []
    for name, changed in levers.items():
        if changed == b:
            continue
        w = run(changed, hazards, d, start_month, alert)
        # More cash lowers the default rate with and without climate, so the
        # lever is judged on the rate with climate, not on the difference
        what_if.append({"condition": name, "pd_with_climate": round(w["pd_with"], 4),
                        "pd_change": round(w["pd_with"] - r["pd_with"], 4)})
    out = {
        "pd_without_climate": round(r["pd_without"], 4),
        "pd_with_climate": round(r["pd_with"], 4),
        "delta_pd_climate": round(delta, 4),
        "climate_premium_bps": round(delta * LGD * 10_000, 1),
        "expected_annual_climate_loss": round(r["expected_loss"]),
        "climate_cfar95": round(r["cfar95"]),
        "cash_reserve_target": round(max(0.0, r["cfar95"] - b.starting_cash)),
        "p_cash_short_30d": round(r["short_30d_with"], 4),
        "p_cash_short_30d_without_climate": round(r["short_30d_without"], 4),
        "loss_by_hazard": {h: round(x) for h, x in r["loss_by_hazard"].items()},
        "what_if": what_if,
        "paths": n,
    }
    if pd_base is not None:
        out["climate_adjusted_pd"] = round(min(pd_base + delta, 1.0), 4)
    return out
