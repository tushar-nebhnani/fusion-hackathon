# Assumptions

Every number below is assumed or borrowed, not measured by us. Each lives in one named constant. Change it there, retrain or rerun, and update this file.

"Not verified" means nobody has checked the figure against its source yet. Do not put it on a slide as fact.

## Cash-flow simulation (`risk/assumptions.py`)

| Constant | Value | Basis |
| --- | --- | --- |
| `LGD` | 45% | Phase 1 notes |
| `DEFAULT_MONTHS_OVERDUE` | 3 months | RBI's NPA definition (90 days past due) |
| `ASSET_DAMAGE` | river flood 0.50, flash flood 0.25, storm 0.40 of monthly revenue per event at vulnerability 1; others 0 | Assumed |
| `EVENT_REACH` | river flood 0.25, flash flood 0.5, storm 0.5, others 1 | Assumed. An IFI record covers a district, rain is on a 50 km grid, storms count within 150 km |
| `DROUGHT_MONTH_LOSS` | 30% of margin in a dry month at vulnerability 1 | Assumed |
| `BACKUP_POWER_DAYS_SAVED` | heat 50%, storm 30% of disrupted days | Assumed |
| `SEASON` | Monthly revenue shape for six sectors; others flat | Assumed |
| What-if levers | 50% insurance recovery; one more month of costs in cash | Chosen for the demo |

Sector vulnerability comes from `features/build_population.py` (`IMPACT`), copied from the input service's sector defaults: heat is evidence-backed, flood is informed by Chennai 2015, storm and cold wave are assumed.

## Hazard event definitions (`risk/hazard_params.py`)

| Hazard | Event day | Basis |
| --- | --- | --- |
| `river_flood` | An IFI flood record covers the cell's district | IFI-Impacts (real records). River discharge is 94% empty, so it is not used |
| `flash_flood` | Rain ≥ 115.6 mm, or ≥ the cell's 99.5th percentile and ≥ 64.5 mm, and not inside a recorded flood | IMD "very heavy" and "heavy" rain classes |
| `heat` | Tmax ≥ 40 °C (37 coastal, 30 hills) and ≥ 4.5 °C above normal, or ≥ 45 °C | IMD heatwave criteria. Not verified against IMD's glossary |
| `cold_wave` | Tmin ≤ 10 °C (0 hills) and ≥ 4.5 °C below normal | IMD cold-wave criteria. Not verified |
| `storm` | IBTrACS cyclonic-storm fix (≥ 34 kt) within 150 km | Real tracks |
| `drought` | 3-month rain with SPI ≤ −1, counted in months | Standard SPI |

"Hills" is the `north_hills` region of `spine.csv`, a rough stand-in for elevation. `TREND_SHRINK` (1.0) and `TREND_CAP` (2×) limit the year trend. River flood and cold wave use no trend.

## Synthetic monthly revenue, model 6 (`features/build_monthly.py`)

| Constant | Value | Basis |
| --- | --- | --- |
| `EVENT_DROP` | flood 0.6, storm 0.5 of revenue at sensitivity 1 | Assumed |
| `RECOVERY_MONTHS` | 2–6 months | Assumed |
| `IDIO_RATE`, `IDIO_DROP`, `IDIO_RECOVERY_MONTHS` | 0.6% a month, 30–60% drop, 3–8 months | Assumed |
| `HEAT_LOSS_PER_C` | 2% per °C above a 1 °C monthly anomaly | Somanathan et al. Not verified |
| `GROWTH`, `NOISE` | 3% ± 5% a year; 5–15% monthly noise | Assumed |
| `EMI_SHARE`, `LATE_BASE`, `LATE_PER_DROP` | 8% of revenue; 3% late; +0.5 per unit drop | Assumed |

## Synthetic loans and defaults, model 5 (`features/build_pd.py`)

| Constant | Value | Basis |
| --- | --- | --- |
| `TARGET_DEFAULT_RATE` | 4% | MSME gross NPA, FY24–25 (CRISIL, CIBIL–SIDBI, RBI). Not verified |
| `B_SIZE` | small +0.25, medium +0.10 log-odds over micro | Direction from CIBIL–SIDBI. Not verified; sizes assumed |
| `B_AGRI` | +0.45 log-odds for agriculture and food processing | Agri gross NPA about 6.1%. Not verified |
| `DSCR_SLOPE`, `BUFFER_SLOPE`, `LATE_SLOPE`, `NOISE_SD` | −1.2, −0.5, +0.35, 0.3 | Assumed shapes, deliberately not the scorecard's |
| `MULTIPLIERS` | 1.0, 1.5, 2.0 | The planted climate effect. 1.5–2× is an assumption; 1.0 is the control |
| `SHOCK_YEARS` | 2 | CAFRAL: stress in the two years after a disaster. Not verified |
| `SCORE_SCALE_DAYS`, `DROUGHT_DAYS_PER_DRY_MONTH` | 15, 5 | Assumed |

The population itself (`features/build_population.py`): equal counts per cell, an assumed size mix (85/12/3) and sector mix, and turnover bands from the MSME limits revised on 1 April 2025 (not verified).
