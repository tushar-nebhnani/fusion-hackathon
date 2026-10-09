"""Location spine: each weather cell -> its IFI district names, coastal flag
and region (plan section 2.1).

Built by hand instead of a pincode join: there are only 38 cells, and IFI's
LGD codes collide (Patna and Visakhapatnam are both 520), so flood events are
matched on district *name*. Every name below was checked against the spelling
used in IFI's `Districts` column.

    python ml/features/spine.py   # writes ml/data/spine.csv
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ML = Path(__file__).resolve().parents[1]
DATA = ML / "data"
sys.path.insert(0, str(DATA))
from fetch_weather import load_locations  # noqa: E402  (same cells as the weather data)

# location_name -> (state, IFI district names, coastal, region)
# Regions are for the leave-one-region-out check in model 4.
CELLS: dict[str, tuple[str, list[str], bool, str]] = {
    "Guwahati": ("Assam", ["Kamrup Metro", "Kamrup"], False, "northeast"),
    "Dispur": ("Assam", ["Kamrup Metro", "Kamrup"], False, "northeast"),
    "Itanagar": ("Arunachal Pradesh", ["Papum Pare"], False, "northeast"),
    "Imphal": ("Manipur", ["Imphal West", "Imphal East"], False, "northeast"),
    "Shillong": ("Meghalaya", ["East Khasi Hills"], False, "northeast"),
    "Aizawl": ("Mizoram", ["Aizawl"], False, "northeast"),
    "Kohima": ("Nagaland", ["Kohima"], False, "northeast"),
    "Gangtok": ("Sikkim", ["Gangtok"], False, "northeast"),
    "Agartala": ("Tripura", ["West Tripura"], False, "northeast"),
    "Chennai": ("Tamil Nadu", ["Chennai"], True, "east_coast"),
    "Puri": ("Odisha", ["Puri"], True, "east_coast"),
    "Bhubaneswar": ("Odisha", ["Khordha"], True, "east_coast"),
    "Amaravati": ("Andhra Pradesh", ["Guntur"], True, "east_coast"),
    "Kolkata": ("West Bengal", ["Kolkata"], True, "east_coast"),
    "Puducherry": ("Puducherry", ["Pondicherry"], True, "east_coast"),
    "Mumbai": ("Maharashtra", ["Mumbai", "Mumbai Suburban"], True, "west_coast"),
    "Panaji": ("Goa", ["North Goa"], True, "west_coast"),
    "Thiruvananthapuram": ("Kerala", ["Thiruvananthapuram"], True, "west_coast"),
    "Gandhinagar": ("Gujarat", ["Gandhinagar"], False, "west_coast"),
    "Daman": ("Dadra and Nagar Haveli and Daman and Diu", ["Daman"], True, "west_coast"),
    "Delhi": ("Delhi", ["New Delhi", "New New Delhi"], False, "interior"),
    "Jaisalmer": ("Rajasthan", ["Jaisalmer"], False, "interior"),
    "Jaipur": ("Rajasthan", ["Jaipur"], False, "interior"),
    "Bengaluru": ("Karnataka", ["Bengaluru Urban"], False, "interior"),
    "Hyderabad": ("Telangana", ["Hyderabad"], False, "interior"),
    "Patna": ("Bihar", ["Patna"], False, "interior"),
    "Raipur": ("Chhattisgarh", ["Raipur"], False, "interior"),
    "Ranchi": ("Jharkhand", ["Ranchi"], False, "interior"),
    "Bhopal": ("Madhya Pradesh", ["Bhopal"], False, "interior"),
    "Lucknow": ("Uttar Pradesh", ["Lucknow"], False, "interior"),
    "Chandigarh": ("Chandigarh", ["Chandigarh"], False, "north_hills"),
    "Shimla": ("Himachal Pradesh", ["Shimla"], False, "north_hills"),
    "Dehradun": ("Uttarakhand", ["Dehradun"], False, "north_hills"),
    "Srinagar": ("Jammu and Kashmir", ["Srinagar"], False, "north_hills"),
    "Jammu": ("Jammu and Kashmir", ["Jammu"], False, "north_hills"),
    "Leh": ("Ladakh", ["Leh ladakh"], False, "north_hills"),
    "Sri Vijaya Puram": ("Andaman and Nicobar Islands", ["South Andamans"], True, "islands"),
    "Kavaratti": ("Lakshadweep", [], True, "islands"),
}


def build() -> pd.DataFrame:
    rows = []
    for loc in load_locations():
        if loc.name not in CELLS:
            raise SystemExit(f"spine: no district entry for {loc.name}; add it to CELLS")
        state, districts, coastal, region = CELLS[loc.name]
        rows.append({
            "location_name": loc.name,
            "cell_lat": loc.cell_lat,
            "cell_lon": loc.cell_lon,
            "state": state,
            "ifi_districts": "|".join(districts),
            "coastal": coastal,
            "region": region,
            "is_preset": "preset" in loc.sources,
        })
    return pd.DataFrame(rows)


if __name__ == "__main__":
    spine = build()
    spine.to_csv(DATA / "spine.csv", index=False)
    print(spine.to_string(index=False))
