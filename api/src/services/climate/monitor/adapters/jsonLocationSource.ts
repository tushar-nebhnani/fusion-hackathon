import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseCoordinates } from "../../coordinates.js";
import type { RunLogger, WatchedLocation, WatchedLocationSource } from "../ports.js";

const entrySchema = z.object({
  locationId: z.string().min(1),
  businessId: z.string().min(1).max(64),
  lat: z.unknown(),
  lon: z.unknown(),
  label: z.string().optional(),
});

// Validates one raw entry with the climate unit's own coordinate rules.
// Throws when the entry cannot be watched.
export function parseLocation(raw: unknown): WatchedLocation {
  const entry = entrySchema.parse(raw);
  const { lat, lon } = parseCoordinates(entry.lat, entry.lon);
  return {
    locationId: entry.locationId,
    businessId: entry.businessId,
    lat,
    lon,
    ...(entry.label ? { label: entry.label } : {}),
  };
}

// Stand-in for the loans DB: a JSON file, read again on every tick so an
// edit takes effect without a restart. A bad entry is skipped, not fatal.
export function createJsonLocationSource(path: string, logger: RunLogger): WatchedLocationSource {
  return {
    async list() {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(raw)) throw new Error(`${path} must hold a JSON array of locations`);
      const locations: WatchedLocation[] = [];
      for (const [index, item] of raw.entries()) {
        try {
          locations.push(parseLocation(item));
        } catch (error) {
          logger.warn(
            `location #${index + 1} in ${path} skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return locations;
    },
  };
}
