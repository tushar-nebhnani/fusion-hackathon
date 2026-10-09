import { describe, expect, it } from "vitest";
import { advance, intervalMs, nextCheckAt, type Cadence } from "./cadence.js";
import { HOUR_MS, SETTINGS, START } from "./testing/fixtures.js";
import type { MonitorLevel } from "./types.js";

const at = (level: MonitorLevel, calmRuns = 0): Cadence => ({ level, calmRuns });
const calm = (current: Cadence, observed: MonitorLevel = "NORMAL") =>
  advance(current, observed, false, SETTINGS);

describe("check interval", () => {
  it("is 6 h at NORMAL, 3 h at WATCH and 1 h at WARNING and SEVERE", () => {
    expect(intervalMs("NORMAL", SETTINGS)).toBe(6 * HOUR_MS);
    expect(intervalMs("WATCH", SETTINGS)).toBe(3 * HOUR_MS);
    expect(intervalMs("WARNING", SETTINGS)).toBe(HOUR_MS);
    expect(intervalMs("SEVERE", SETTINGS)).toBe(HOUR_MS);
  });

  it("schedules the next check one interval after now", () => {
    expect(nextCheckAt(START, "WATCH", SETTINGS)).toEqual(new Date(START.getTime() + 3 * HOUR_MS));
  });

  it("comes from the settings, not from constants", () => {
    const settings = { ...SETTINGS, intervalHours: { ...SETTINGS.intervalHours, NORMAL: 12 } };
    expect(intervalMs("NORMAL", settings)).toBe(12 * HOUR_MS);
  });
});

describe("escalation", () => {
  it("jumps from NORMAL straight to WARNING", () => {
    expect(advance(at("NORMAL"), "WARNING", true, SETTINGS)).toEqual(at("WARNING"));
  });

  it("jumps from NORMAL straight to SEVERE", () => {
    expect(advance(at("NORMAL"), "SEVERE", true, SETTINGS)).toEqual(at("SEVERE"));
  });

  it("clears the calm count", () => {
    expect(advance(at("WATCH", 1), "WARNING", true, SETTINGS)).toEqual(at("WARNING", 0));
  });
});

describe("de-escalation", () => {
  it("keeps WARNING after one calm run", () => {
    expect(calm(at("WARNING"))).toEqual(at("WARNING", 1));
  });

  it("steps WARNING down to WATCH only after 2 calm runs in a row", () => {
    const once = calm(at("WARNING"));
    expect(once.level).toBe("WARNING");
    expect(calm(once)).toEqual(at("WATCH", 0));
  });

  it("steps down one level at a time, even when the forecast is fully calm", () => {
    let state = at("SEVERE");
    const seen: MonitorLevel[] = [];
    for (let run = 0; run < 6; run++) {
      state = calm(state);
      seen.push(state.level);
    }
    expect(seen).toEqual(["SEVERE", "WARNING", "WARNING", "WATCH", "WATCH", "NORMAL"]);
  });

  it("starts counting again after each step down", () => {
    expect(calm(calm(at("SEVERE")))).toEqual(at("WARNING", 0));
  });

  it("resets the count when a run is not calm", () => {
    const once = calm(at("WARNING"));
    const stillWarning = advance(once, "WARNING", false, SETTINGS);
    expect(stillWarning).toEqual(at("WARNING", 0));
    // So two more calm runs are needed, not one
    expect(calm(stillWarning).level).toBe("WARNING");
    expect(calm(calm(stillWarning)).level).toBe("WATCH");
  });

  it("resets the count on a sudden change below the cell's level", () => {
    // Another hazard rose to WATCH while the cell is still at WARNING
    expect(advance(at("WARNING", 1), "WATCH", true, SETTINGS)).toEqual(at("WARNING", 0));
  });

  it("does not step down while a hazard is still at the cell's level", () => {
    let state = at("WARNING");
    for (let run = 0; run < 5; run++) state = advance(state, "WARNING", false, SETTINGS);
    expect(state).toEqual(at("WARNING", 0));
  });

  it("counts a run as calm when the hazard has eased below the cell's level", () => {
    expect(calm(at("WARNING"), "WATCH")).toEqual(at("WARNING", 1));
    expect(calm(at("WARNING", 1), "WATCH")).toEqual(at("WATCH", 0));
  });

  it("stays at NORMAL", () => {
    expect(calm(at("NORMAL"))).toEqual(at("NORMAL", 0));
  });

  it("honours a different number of calm runs", () => {
    const settings = { ...SETTINGS, calmRunsToStepDown: 3 };
    let state = at("WATCH");
    state = advance(state, "NORMAL", false, settings);
    state = advance(state, "NORMAL", false, settings);
    expect(state).toEqual(at("WATCH", 2));
    expect(advance(state, "NORMAL", false, settings)).toEqual(at("NORMAL", 0));
  });
});
