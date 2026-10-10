import { AppError } from "../../errors/app-error.js";
import { CLIMATE } from "../../config/climate.js";

// Counts, per signed-in user, the lookups that need a place's history
// downloaded. A request with no requester (warming, the refresh job, the
// monitor) is never counted. In this process only, like the cell lock.
export interface NewPlaceGate {
  // Throws 429 NEW_PLACE_LIMIT when the user has used up their allowance
  take(requesterId: string | null): void;
}

export function createNewPlaceGate(
  options: { perUser: number; windowMs: number; now?: () => number } = CLIMATE.newPlaceLookups,
): NewPlaceGate {
  const now = options.now ?? Date.now;
  const taken = new Map<string, number[]>();

  return {
    take(requesterId) {
      if (!requesterId) return;
      const at = now();
      const recent = (taken.get(requesterId) ?? []).filter((time) => at - time < options.windowMs);
      if (recent.length >= options.perUser) {
        taken.set(requesterId, recent);
        const retryAfter = Math.ceil(((recent[0] ?? at) + options.windowMs - at) / 1000);
        throw new AppError(
          `Too many new places: at most ${String(options.perUser)} unscreened locations per ${String(options.windowMs / 60_000)} minutes. Places already screened still work; try a new one in ${String(retryAfter)} s`,
          429,
          "NEW_PLACE_LIMIT",
          { retry_after_seconds: retryAfter },
        );
      }
      recent.push(at);
      taken.set(requesterId, recent);
      // Users with nothing recent are dropped, so the map does not grow
      for (const [user, times] of taken) {
        if (times.every((time) => at - time >= options.windowMs)) taken.delete(user);
      }
    },
  };
}
