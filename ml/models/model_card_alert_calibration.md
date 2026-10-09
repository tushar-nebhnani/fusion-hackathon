# Model 4: alert calibration (flood)

**Version** `alert-cal-0.1.0` · **File** `alert_calibration_flood.joblib` (16 KB) · **Demo model**

## What it does
When a flood alert fires, it estimates the chance that a real, recorded flood follows (IFI-Impacts, within 1 day before to 3 days after). It ranks alerts; it never changes the rules or the credit score, and it fails open: if the service is down or the point is more than 150 km from a trained cell, the alert goes out exactly as today.

## Data
- **Weather:** NASA POWER daily, 1995–2023, 37 distinct cells (state and UT capitals plus the 8 demo cities). 0.5° grid, coarser than the live API's 0.1° ERA5.
- **Labels:** IFI-Impacts flood inventory (IIT Delhi, Zenodo 16994648), matched to cells by district name.
- **Alerts replayed:** the live IMD heavy-rain rule (≥ 64.5 mm in a day) **or** 3-day rain above the cell's own 95th percentile. The IMD rule alone catches only 20% of floods on this coarse data.
- **Split by time:** train 1995–2015 (4,605 alerts, 449 real) · validate 2016–2019 · test 2020–2023 (1,127 alerts, 78 real).

## Results on 2020–2023 (never seen in training)

| | Rule alone | Model 4 |
|---|---|---|
| PR-AUC (ranking real floods first) | 0.079 | **0.170** (2.2×) |
| Brier score (probability accuracy) | 0.0649 | 0.0645 (about the same) |
| High band: share of alerts that were real | 6.9% | **17.3%**, holding 47% of real floods and dropping 83% of false alarms |
| Low cut: alerts below the low band | – | drops 41% of false alarms, but also loses 24% of real floods |

Held-out regions (trained without them): PR-AUC is 2–3× the region's base rate in every region with enough events.

## Limits, stated plainly
- **Hindcast on observed weather.** Real forecasts are noisier, so live precision will be lower.
- **46% of floods had no alert at all.** Rain on this grid doesn't explain them (river or upstream causes). Calibrating alerts can't recover these.
- **Reporting bias.** IFI records jump in 2021–2023 (2022 has about 3× the usual count). That inflates the test base rate.
- **Storm:** 30 training hits, under the minimum of 50. Storm alerts get the rule's base rate only.
- **Heat, drought, cold wave:** there is no verified event dataset to label them, so they stay rule-only.

## Rebuild
```bash
cd ml
.venv-data/bin/python data/fetch_power.py && .venv-data/bin/python data/fetch_power.py --merge
.venv-data/bin/python features/spine.py && (cd features && ../.venv-data/bin/python build_events.py)
.venv-data/bin/python training/train_alert_calibration.py
.venv-data/bin/python -m pytest tests -q
```
