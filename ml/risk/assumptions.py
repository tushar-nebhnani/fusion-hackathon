"""Every assumed number the cash-flow simulation and the synthetic data use.
None is measured by us. data/ASSUMPTIONS.md lists them with their sources.
"""

from __future__ import annotations

HAZARDS = ["river_flood", "flash_flood", "heat", "drought", "storm", "cold_wave"]

# Loss given default, as in the phase 1 notes
LGD = 0.45
# RBI's NPA definition: 90 days past due
DEFAULT_MONTHS_OVERDUE = 3

# ASSUMED. One-off asset or stock damage per event, as a share of monthly
# revenue, for a business with vulnerability 1
ASSET_DAMAGE = {"river_flood": 0.50, "flash_flood": 0.25, "heat": 0.0, "drought": 0.0,
                "storm": 0.40, "cold_wave": 0.0}
# ASSUMED. Share of recorded events that reach a given business: an IFI flood
# record covers a whole district, heavy rain is measured on a 50 km grid, and
# a storm counts within 150 km
EVENT_REACH = {"river_flood": 0.25, "flash_flood": 0.5, "heat": 1.0, "drought": 1.0,
               "storm": 0.5, "cold_wave": 1.0}
# ASSUMED. Share of margin lost in an SPI-dry month at vulnerability 1
DROUGHT_MONTH_LOSS = 0.30
# ASSUMED. Backup power keeps this share of heat and storm days productive
BACKUP_POWER_DAYS_SAVED = {"heat": 0.5, "storm": 0.3}

# What-if levers shown as loan conditions
WHAT_IF_INSURANCE_RECOVERY = 0.5
WHAT_IF_EXTRA_BUFFER_MONTHS = 1.0  # extra cash, in months of fixed costs plus EMI

# ASSUMED monthly revenue shape per sector (Jan..Dec, mean 1). Retail peaks at
# the Oct-Nov festivals, construction dips in the monsoon, agriculture and
# food processing peak after harvest. Unlisted sectors are flat
SEASON = {
    "retail": [0.95, 0.90, 0.95, 0.95, 0.95, 0.90, 0.90, 0.95, 1.00, 1.25, 1.25, 1.05],
    "apparel_footwear": [0.95, 0.90, 0.95, 1.00, 0.95, 0.85, 0.85, 0.95, 1.00, 1.25, 1.25, 1.10],
    "construction": [1.10, 1.10, 1.15, 1.10, 1.05, 0.85, 0.70, 0.70, 0.85, 1.10, 1.15, 1.15],
    "agriculture": [1.00, 0.90, 1.00, 1.20, 1.10, 0.80, 0.75, 0.80, 0.90, 1.20, 1.25, 1.10],
    "food_processing": [1.00, 0.95, 1.00, 1.10, 1.05, 0.90, 0.85, 0.90, 0.95, 1.10, 1.15, 1.05],
    "hospitality_tourism": [1.15, 1.05, 1.00, 1.00, 1.05, 0.85, 0.75, 0.80, 0.90, 1.10, 1.15, 1.20],
}


def season(sector: str | None) -> list[float]:
    return SEASON.get(sector or "", [1.0] * 12)
