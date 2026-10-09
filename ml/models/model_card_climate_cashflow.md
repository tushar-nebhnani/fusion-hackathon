# Climate cash-flow simulation

**Code** `risk/hazard_params.py`, `risk/cashflow_sim.py` · **Endpoint** `POST /risk/climate-cashflow` · **Not a trained model**

## What it does
It simulates a business's cash month by month, 20,000 times over 12 months, with and without weather events, on the same random draws. The difference in how often the business falls three months behind on its EMI is the climate effect (`delta_pd_climate`). It also returns a pricing premium, the expected yearly loss to weather, a 95th-percentile loss (`climate_cfar95`), a cash reserve target, the chance of running short this month, and the effect of three loan conditions.

It is shown beside the scorecard. It does not change the scorecard.

## What is measured and what is assumed
- **Measured:** how often each hazard hits each of the 38 cells and for how long, from 1995–2023 weather, IFI flood records and IBTrACS storm tracks (`data/hazard_params.csv`). The business's financials come from the request.
- **Assumed:** how much one event costs a business (asset damage, the share of events that reach it, sector vulnerability, drought loss). All are in `data/ASSUMPTIONS.md`.

## Checks
- **Direction (unit tests):** more cash, insurance or backup power never raises the default rate; more frequent or longer events and higher vulnerability never lower it; zero vulnerability gives zero effect.
- **Convergence:** the result moves by under 2 points between 10,000 and 40,000 paths (0.1 points in practice).
- **Backtest of the event rates:** fitted on 1995–2015, checked on 2016–2023.

| Hazard | Observed events 2016–23 | Predicted | Trend beats a constant rate? |
|---|---|---|---|
| River flood | 325 | 288 | No trend used (IFI reporting jump) |
| Flash flood | 244 | 193 | Yes |
| Heat | 400 | 482 | Yes |
| Drought months | 349 | 558 | Yes |
| Storm | 33 | 15 | About the same |
| Cold wave | 542 | 434 | No, so no trend used |

## Example: one made-up retailer in June
₹3 lakh monthly revenue, 60% variable costs, ₹75k fixed costs, ₹25k EMI, ₹60k cash, sector defaults.

| City | Climate effect on default | Premium | Expected loss a year |
|---|---|---|---|
| Guwahati | +22.0 points | 989 bps | ₹1.32 lakh |
| Mumbai | +20.1 points | 906 bps | ₹1.33 lakh |
| Chennai | +9.5 points | 429 bps | ₹0.75 lakh |
| Puri | +6.5 points | 293 bps | ₹0.66 lakh |
| Delhi | +2.7 points | 120 bps | ₹0.46 lakh |
| Jaisalmer | +2.0 points | 88 bps | ₹0.26 lakh |
| Leh | +0.6 points | 26 bps | ₹0.21 lakh |

The order is driven by measured event rates. **The sizes are driven by the assumed cost of an event** and would change with those assumptions.

## Limits, stated plainly
- **Only the difference means anything.** The base default rate of this cash model is not calibrated to real defaults.
- **The predicted counts miss by 10–60% in the backtest**, and storms were under-predicted by half.
- **River-flood rates inherit IFI's reporting bias** and its district-wide footprint.
- **Not done from the plan:** severity from a GEV fit (every event of a hazard costs the same), the agreement check against the scorecard's `climate_premium`, and wiring into the finance service or `credit.html`.
- **Hill cells are the `north_hills` region**, a rough stand-in for elevation.

## Rebuild
```bash
cd ml
.venv-data/bin/python risk/hazard_params.py             # writes data/hazard_params.csv
.venv-data/bin/python risk/hazard_params.py --backtest
.venv-data/bin/python -m pytest tests -q
```
