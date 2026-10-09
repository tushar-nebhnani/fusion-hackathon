# Model 4: alert calibration (flood and storm)

**Version** `alert-cal-0.2.0` · **Files** `alert_calibration_flood.joblib` (19 KB), `alert_calibration_storm.joblib` (11 KB) · **Demo models**

## What it does
When a flood or storm alert fires, it estimates the chance that a real, recorded event follows (within 1 day before to 3 days after). It ranks alerts; it never changes the rules or the credit score, and it fails open: if the service is down, the point is more than 150 km from a trained cell, or a storm request has no wind and pressure, the alert goes out exactly as today.

## Data
- **Weather:** NASA POWER daily, 1995–2023, 37 distinct cells (state and UT capitals plus the 8 demo cities). 0.5° grid, coarser than the live API's 0.1° ERA5.
- **Flood labels:** IFI-Impacts flood inventory (IIT Delhi, Zenodo 16994648), matched to cells by district name.
- **Storm labels:** IBTrACS North Indian basin, a cyclonic-storm fix (IMD wind ≥ 34 kt) within 150 km of the cell. Only the 19 cells storms reach are scored.
- **Flood alerts replayed:** the live IMD heavy-rain rule (≥ 64.5 mm in a day) **or** 3-day rain above the cell's own 95th percentile. The IMD rule alone catches only 20% of floods on this coarse data.
- **Storm alerts replayed:** daily wind **or** rain above the cell's own 99th percentile.
- **Split by time:** train 1995–2015 · validate 2016–2019 · test 2020–2023.

| | Train alerts (real) | Test alerts (real) |
|---|---|---|
| Flood | 4,605 (449) | 1,127 (78) |
| Storm | 1,833 (30) | 372 (16) |

## Model
Logistic regression on standardised features, chosen over gradient boosting on validation PR-AUC, with Platt scaling fitted on validation. Platt replaced isotonic in 0.2.0: isotonic gave the flood test alerts only 28 distinct scores, which cost ranking (PR-AUC 0.170 against 0.198) and probability accuracy.

## Results on 2020–2023 (never seen in training)

| Flood | Rule alone | Model 4 |
|---|---|---|
| PR-AUC (ranking real floods first) | 0.079 | **0.198** (2.5×) |
| Brier score (probability accuracy, lower is better) | 0.0649 | **0.0618** |
| High band: share of alerts that were real | 6.9% | **17.9%**, holding 46% of real floods and dropping 84% of false alarms |
| Low cut: alerts below the low band | – | drops 44% of false alarms, but also loses 24% of real floods |

| Storm | Rule alone | Model 4 |
|---|---|---|
| PR-AUC | 0.051 | **0.525** |
| Brier score | 0.0417 | **0.0290** |
| High band: share of alerts that were real | 4.3% | **31.4%**, holding 11 of 16 real storms and dropping 93% of false alarms |
| Low cut: alerts below the low band | – | drops 79% of false alarms and loses 2 of 16 real storms |

Held-out regions (trained without them): flood PR-AUC is about 2–6× the region's base rate in every region with enough events; storm is 5–22× in the three regions that could be scored.

## What was tried and did not help
Chosen on 1995–2019 only, by year-by-year cross-validation. None of these beat the plain logistic by more than noise on flood, and all were worse or no better on storm: XGBoost, LightGBM, CatBoost, random forest, extra trees, k-nearest neighbours, SVM and a small neural network; class weighting and SMOTE; a 150-trial Optuna search per hazard; and new features from the raw weather (rain shape, 60-day memory, root-zone soil, pressure and wind change, river discharge, interactions). The limit is the data, not the algorithm.

## Limits, stated plainly
- **Accuracy is the wrong measure.** 93% of flood alerts are not followed by a flood, so "never a flood" is 93% accurate and useless. Read PR-AUC and the band rows instead.
- **Storm rests on 30 training and 16 test storms.** The plan's minimum was 50 training hits; it was lowered to 25 because the test result is far above the rule. Expect these numbers to move.
- **Hindcast on observed weather.** Real forecasts are noisier, so live precision will be lower.
- **46% of floods had no alert at all.** Rain on this grid doesn't explain them (river or upstream causes), and river discharge is 94% empty. Calibrating alerts can't recover these.
- **Reporting bias.** IFI records jump in 2021–2023 (2022 has about 3× the usual count). That inflates the flood test base rate.
- **Storm needs wind and pressure in the request** (`wind_speed_10m_max`, `surface_pressure_mean`); without both it returns the rule's base rate.
- **Heat, drought, cold wave:** there is no verified event dataset to label them, so they stay rule-only.

## Rebuild
```bash
cd ml
.venv-data/bin/python data/fetch_power.py && .venv-data/bin/python data/fetch_power.py --merge
.venv-data/bin/python features/spine.py && (cd features && ../.venv-data/bin/python build_events.py)
.venv-data/bin/python training/train_alert_calibration.py
.venv-data/bin/python -m pytest tests -q
```
