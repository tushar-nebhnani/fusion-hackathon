"""Real event tables, the ground truth for model 4 (plan section 2.2).

    events_flood.csv  one row per (cell, IFI flood event), matched on district name
    events_storm.csv  one row per (cell, storm, IST date) with a cyclonic-storm
                      fix (IMD wind >= 34 kt) within MAX_RADIUS_KM of the cell

    python ml/features/build_events.py
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from spine import DATA, build as build_spine

EXTERNAL = DATA / "external"
YEARS = (1995, 2023)  # weather starts 1995; IFI ends Sept 2023
# Keep everything within the widest radius; models filter to 100/150/200 km
MAX_RADIUS_KM = 200
# IMD "cyclonic storm" and stronger
MIN_WIND_KT = 34


def floods(spine: pd.DataFrame) -> pd.DataFrame:
    ifi = pd.read_csv(EXTERNAL / "ifi" / "India_Flood_Inventory_v3.csv", low_memory=False)
    ifi["start_date"] = pd.to_datetime(ifi["Start Date"], format="%d-%m-%Y %H:%M", errors="coerce")
    ifi["end_date"] = pd.to_datetime(ifi["End Date"], format="%d-%m-%Y %H:%M", errors="coerce")
    # some IFI rows end before they start (day/month swaps); treat them as one day
    ifi["end_date"] = ifi.end_date.fillna(ifi.start_date).where(ifi.end_date >= ifi.start_date, ifi.start_date)
    ifi = ifi[ifi.start_date.dt.year.between(*YEARS) & ifi.Districts.notna()]
    ifi = ifi.assign(district=ifi.Districts.str.split(",")).explode("district")
    ifi["district"] = ifi.district.str.strip().str.lower()

    names = (spine.assign(district=spine.ifi_districts.str.split("|"))
             .explode("district").dropna(subset=["district"]))
    names = names[names.district != ""]
    names["district"] = names.district.str.lower()

    out = ifi.merge(names[["location_name", "district"]], on="district")
    out = out.assign(
        deaths=pd.to_numeric(out["Human fatality"], errors="coerce"),
        displaced=pd.to_numeric(out["Human Displaced"], errors="coerce"),
        cause=out["Main Cause"].str.strip().str.lower(),
    )
    # an event listing both Kamrup and Kamrup Metro must count once per cell
    out = out.drop_duplicates(["location_name", "UEI"])
    out = out[["location_name", "UEI", "start_date", "end_date", "deaths", "displaced", "cause"]]
    return out.rename(columns={"UEI": "uei"}).sort_values(["location_name", "start_date"])


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = (np.sin((lat2 - lat1) / 2) ** 2
         + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2)
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def storms(spine: pd.DataFrame) -> pd.DataFrame:
    cols = ["SID", "NAME", "ISO_TIME", "LAT", "LON", "WMO_WIND", "WMO_AGENCY", "NEWDELHI_WIND"]
    t = pd.read_csv(EXTERNAL / "ibtracs" / "ibtracs.NI.list.v04r01.csv",
                    skiprows=[1], usecols=cols, low_memory=False)  # row 1 holds units
    for c in ["LAT", "LON", "WMO_WIND", "NEWDELHI_WIND"]:
        t[c] = pd.to_numeric(t[c], errors="coerce")
    # IMD's own estimate first; WMO_WIND only when IMD is the reporting agency
    t["wind_kt"] = t.NEWDELHI_WIND.fillna(t.WMO_WIND.where(t.WMO_AGENCY == "newdelhi"))
    # IBTrACS times are UTC; dates are matched in IST like the rest of the project
    t["date"] = (pd.to_datetime(t.ISO_TIME) + pd.Timedelta(hours=5, minutes=30)).dt.normalize()
    t = t[t.date.dt.year.between(*YEARS) & (t.wind_kt >= MIN_WIND_KT)]

    rows = []
    for cell in spine.itertuples():
        d = haversine_km(cell.cell_lat, cell.cell_lon, t.LAT.values, t.LON.values)
        near = t[d <= MAX_RADIUS_KM].assign(distance_km=d[d <= MAX_RADIUS_KM])
        if near.empty:
            continue
        g = (near.groupby(["SID", "NAME", "date"])
             .agg(min_distance_km=("distance_km", "min"), max_wind_kt=("wind_kt", "max"))
             .reset_index())
        g.insert(0, "location_name", cell.location_name)
        rows.append(g)
    out = pd.concat(rows, ignore_index=True).rename(columns={"SID": "storm_id", "NAME": "storm_name"})
    out["min_distance_km"] = out.min_distance_km.round(1)
    return out.sort_values(["location_name", "date"])


if __name__ == "__main__":
    spine = build_spine()
    f = floods(spine)
    s = storms(spine)
    f.to_csv(DATA / "events_flood.csv", index=False, date_format="%Y-%m-%d")
    s.to_csv(DATA / "events_storm.csv", index=False, date_format="%Y-%m-%d")

    summary = spine[["location_name", "region"]].set_index("location_name")
    summary["floods"] = f.groupby("location_name").size()
    summary["floods_95_20"] = f[f.start_date.dt.year <= 2020].groupby("location_name").size()
    for r in (100, 150, 200):
        summary[f"storms_{r}km"] = s[s.min_distance_km <= r].groupby("location_name").storm_id.nunique()
    print(summary.fillna(0).astype({c: int for c in summary.columns if c != "region"})
          .sort_values("floods", ascending=False).to_string())
    print(f"\nflood rows {len(f)}, storm rows {len(s)} ({s.storm_id.nunique()} storms)")
    print("floods per year:", f.groupby(f.start_date.dt.year).size().to_dict())
