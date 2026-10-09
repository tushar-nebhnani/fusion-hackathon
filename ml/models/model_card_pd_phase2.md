# Model 5: credit PD, phase 2 pipeline

**Version** `pd-phase2-0.1.0` · **Files** `pd_phase2_m10.joblib`, `pd_phase2_m15.joblib`, `pd_phase2_m20.joblib` · **Synthetic labels. Not served. Cannot set the live score.**

## What it is
The training pipeline that would replace the scorecard once a partner bank's repayment data exists, run end to end on made-up loans. A model trained on labels we generate can only learn our formula back, so it proves three narrower things:

1. The pipeline runs: features, a monotonic model, held-out evaluation, a model card.
2. It finds an effect we planted: a climate multiplier `m` on the odds of default.
3. The same loans come out riskiest whichever `m` is assumed.

## Data
**Every loan and label is synthetic.** 76,000 loans (3,800 made-up businesses × 20 loan years, 2004–2023). The label formula has its own shapes and weights, not the scorecard's, with a 4% target default rate (not verified against its sources). Climate shocks land on real flood and storm years for the business's cell. Three datasets: `m` = 1.0 (climate does not matter), 1.5 and 2.0.

## Method
Logistic regression and gradient-boosted trees with monotonic constraints (risk rises with debt and late payments, falls with DSCR and cash buffer). Ten whole cells are held out, so the test is on places the model never saw. The model with the lower Brier score is saved.

## Results on the 10 held-out cells (20,000 loans)

| `m` | Kept | AUC | KS | Brier | Brier, rate by size only | AUC ceiling (true PD) |
|---|---|---|---|---|---|---|
| 1.0 | logistic | 0.658 | 0.240 | 0.03859 | 0.03909 | 0.685 |
| 1.5 | logistic | 0.663 | 0.251 | 0.03853 | 0.03904 | 0.688 |
| 2.0 | boosted | 0.658 | 0.235 | 0.03836 | 0.03890 | 0.691 |

The AUC is low because the labels are mostly chance by construction: even the true PD scores only 0.69.

**Did it find the planted effect?** Logistic coefficient on `climate_shock`, with a 95% interval from resampling cells:

| `m` | Planted (log m) | Estimated | 95% interval |
|---|---|---|---|
| 1.0 | 0.000 | −0.070 | −0.351 to 0.712 |
| 1.5 | 0.405 | 0.333 | 0.028 to 1.238 |
| 2.0 | 0.693 | 0.546 | 0.266 to 1.603 |

The planted value is inside the interval every time, and the estimate rises with `m`, but the intervals are wide. Predicted PD for the most-shocked loans against calm high-exposure loans: 1.16× at `m` = 1.5 (truth 1.18×) and 1.35× at `m` = 2.0 (truth 1.38×), from the logistic.

**Robustness:** the rank order of the test loans agrees across multipliers (Spearman 0.97 to 0.99).

## Limits, stated plainly
- **It is not evidence about real defaults.** Every number above describes our own generator.
- **The boosted model understates the planted effect** (1.21× against 1.38× at `m` = 2.0); the logistic recovers it better.
- **Not done from the plan:** SHAP plots (the dependency was not added; coefficients and a shuffle test stand in), and rank agreement with the live scorecard (it needs the API running with a signed-in user).
- **The calibration targets are unverified** (`data/ASSUMPTIONS.md`).

## Rebuild
```bash
cd ml
.venv-data/bin/python risk/hazard_params.py
.venv-data/bin/python training/train_pd.py
```
