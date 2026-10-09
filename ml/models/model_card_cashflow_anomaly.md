# Model 6: cash-flow anomaly detection

**Version** `cashflow-anomaly-0.1.0` · **File** `cashflow_anomaly.joblib` (529 KB) · **Demo model, synthetic data**

## What it does
It flags a business whose monthly revenue breaks from its own pattern, and says whether the break is shared with the neighbourhood (`systemic`, likely weather) or is the business's alone (`idiosyncratic`). It feeds early-intervention alerts and advice. It never changes the credit score.

## Data
**Every revenue series is synthetic.** 1,140 made-up businesses (30 per weather cell), monthly, 2015–2023. Shocks are placed on the real flood and storm dates for each cell, plus business-only shocks at a small random rate. Sizes and recovery times are assumptions (`data/ASSUMPTIONS.md`).

## Method
An IsolationForest on seven features of the business's own history: revenue against the same month last year, against its trailing year, month-on-month change, drawdown, months below its median, and late payments. Only drops are flagged. Fitted on 2015–2019, scored on 2020–2023.

The systemic split is a rule, not a model: a flagged month is systemic when at least 30% of the businesses in the same cell are also well below their pattern.

## Results on 2020–2023

| | Rule (z < −2.5 for 2 months) | IsolationForest |
|---|---|---|
| Shared shocks caught within 3 months (4,364) | 9.6% | **75.8%** |
| Business-only shocks caught (336) | 6.8% | **89.3%** |
| Average delay when caught | 0.7 months | 0.3 and 0.1 months |
| Share of the top 20 a month that are real shocks | 67.9% | **83.9%** |
| Share of all flags that are real shocks | 94.9% | 79.6% |
| Share of business-months flagged | 0.4% | 9.7% |

Systemic split on flagged real shocks: 79.7% of shared shocks and 89.6% of business-only shocks recognised (balanced accuracy 0.846).

## Limits, stated plainly
- **This shows the detector finds the shocks we injected.** It says nothing about how often real businesses behave this way.
- **The rule is more precise but misses nine in ten shocks.** The forest flags about one business-month in ten, and one flag in five is not a real shock.
- **It needs 13 months of history**, and the production database stores one snapshot, not a monthly series.
- **The service sees one business at a time.** The caller must send the share of the cell that is anomalous, or whether a climate event is active; without either, every flag is called business-only.
- **The peer threshold was tuned on the synthetic 2016–2019 years.**

## Rebuild
```bash
cd ml
.venv-data/bin/python training/train_anomaly.py
.venv-data/bin/python -m pytest tests -q
```
