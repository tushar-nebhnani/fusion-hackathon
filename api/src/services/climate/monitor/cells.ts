import { snapPoint } from "../grid.js";
import type { WatchedLocation } from "./ports.js";

export interface CellGroup {
  // The forecast cache's cell id
  cellId: string;
  // Where the cell is checked: its first location
  lat: number;
  lon: number;
  locations: WatchedLocation[];
}

// Groups locations by the climate unit's forecast cell. One group means one
// check, whatever the number of businesses inside. Ordered by id so the same
// input always gives the same groups and the same check point.
export function groupByCell(locations: WatchedLocation[]): CellGroup[] {
  const groups = new Map<string, CellGroup>();
  const ordered = [...locations].sort((a, b) => a.locationId.localeCompare(b.locationId));
  for (const location of ordered) {
    const cellId = snapPoint(location.lat, location.lon).forecast.id;
    const group = groups.get(cellId);
    if (group) group.locations.push(location);
    else groups.set(cellId, { cellId, lat: location.lat, lon: location.lon, locations: [location] });
  }
  return [...groups.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
}
