import { describe, expect, it } from "vitest";
import { snapPoint } from "../grid.js";
import { groupByCell } from "./cells.js";
import { CHENNAI, CHENNAI_CELL, CHENNAI_NEIGHBOUR, PUNE, PUNE_CELL } from "./testing/fixtures.js";

describe("groupByCell", () => {
  it("puts two locations in the same grid cell into one group", () => {
    const groups = groupByCell([CHENNAI, CHENNAI_NEIGHBOUR]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.cellId).toBe(CHENNAI_CELL);
    expect(groups[0]?.locations.map((l) => l.businessId)).toEqual(["SME-0142", "SME-0143"]);
  });

  it("keeps locations in different cells apart", () => {
    const groups = groupByCell([CHENNAI, PUNE, CHENNAI_NEIGHBOUR]);

    expect(groups.map((g) => g.cellId)).toEqual([CHENNAI_CELL, PUNE_CELL]);
    expect(groups.map((g) => g.locations.length)).toEqual([2, 1]);
  });

  it("uses the forecast cache's cell id, so a monitor cell is a cache cell", () => {
    const [group] = groupByCell([PUNE]);

    expect(group?.cellId).toBe(snapPoint(PUNE.lat, PUNE.lon).forecast.id);
  });

  it("checks the cell at its first location, whatever order they arrive in", () => {
    const forwards = groupByCell([CHENNAI, CHENNAI_NEIGHBOUR]);
    const backwards = groupByCell([CHENNAI_NEIGHBOUR, CHENNAI]);

    expect(backwards).toEqual(forwards);
    expect(forwards[0]).toMatchObject({ lat: CHENNAI.lat, lon: CHENNAI.lon });
  });

  it("returns nothing for no locations", () => {
    expect(groupByCell([])).toEqual([]);
  });
});
