import { CLIMATE } from "../../config/climate.js";

export interface Cell {
  id: string;
  resolution: number;
  lat: number;
  lon: number;
}

export interface Cells {
  historical: Cell;
  climate: Cell;
  flood: Cell;
  forecast: Cell;
}

function decimals(resolution: number): number {
  return (String(resolution).split(".")[1] ?? "").length;
}

// Snaps to the nearest cell centre. Rounding goes through the integer cell
// index so the result does not drift with floating point error.
export function snap(value: number, resolution: number): number {
  const snapped = Math.round(value / resolution) * resolution;
  return Number(snapped.toFixed(decimals(resolution)));
}

// Cell key format: "<resolution>:<lat_snapped>:<lon_snapped>"
export function snapCell(lat: number, lon: number, resolution: number): Cell {
  const d = decimals(resolution);
  const cellLat = snap(lat, resolution);
  const cellLon = snap(lon, resolution);
  return {
    id: `${resolution}:${cellLat.toFixed(d)}:${cellLon.toFixed(d)}`,
    resolution,
    lat: cellLat,
    lon: cellLon,
  };
}

export function snapPoint(lat: number, lon: number): Cells {
  return {
    historical: snapCell(lat, lon, CLIMATE.grid.historical),
    climate: snapCell(lat, lon, CLIMATE.grid.climate),
    flood: snapCell(lat, lon, CLIMATE.grid.flood),
    forecast: snapCell(lat, lon, CLIMATE.grid.forecast),
  };
}

const CELL_ID_PATTERN = /^(\d\.\d{1,2}):(-?\d{1,2}\.\d{1,2}):(-?\d{1,3}\.\d{1,2})$/;

// Accepts only canonical ids of a configured resolution; anything else is null
export function parseCellId(id: string): Cell | null {
  const match = CELL_ID_PATTERN.exec(id);
  if (!match) return null;
  const resolution = Number(match[1]);
  const known: number[] = Object.values(CLIMATE.grid);
  if (!known.includes(resolution)) return null;
  const cell = snapCell(Number(match[2]), Number(match[3]), resolution);
  return cell.id === id ? cell : null;
}
