import type { RunLogger, WatchedLocation, WatchedLocationSource } from "../ports.js";
import { parseLocation } from "./jsonLocationSource.js";

// The input service's primary locations of businesses with an authorised or
// active loan (store.activeLocations). Passed in, so the monitor does not
// import the input service.
export type ActiveLocations = () => Promise<{ business_id: string; lat: number; lon: number }[]>;

// The loans DB behind the monitor. Read again on every tick, so a loan that
// is authorised or closed is picked up without a restart. One primary
// location per business, so the business id doubles as the location id.
export function createInputLocationSource(
  activeLocations: ActiveLocations,
  logger: RunLogger,
): WatchedLocationSource {
  return {
    async list() {
      const locations: WatchedLocation[] = [];
      for (const row of await activeLocations()) {
        try {
          locations.push(
            parseLocation({
              locationId: row.business_id,
              businessId: row.business_id,
              lat: row.lat,
              lon: row.lon,
            }),
          );
        } catch (error) {
          logger.warn(
            `location of business ${row.business_id} skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return locations;
    },
  };
}
