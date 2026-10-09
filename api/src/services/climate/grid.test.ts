import { describe, expect, it } from "vitest";
import { parseCellId, snap, snapCell, snapPoint } from "./grid.js";

describe("grid snapping", () => {
  it("snaps to the nearest cell centre without floating point drift", () => {
    expect(snap(26.1445, 0.1)).toBe(26.1);
    expect(snap(26.1445, 0.05)).toBe(26.15);
    expect(snap(91.7362, 0.05)).toBe(91.75);
    expect(snap(0.3, 0.1)).toBe(0.3);
  });

  it("formats cell keys as <resolution>:<lat>:<lon>", () => {
    expect(snapCell(26.1445, 91.7362, 0.1).id).toBe("0.1:26.1:91.7");
    expect(snapCell(26.1445, 91.7362, 0.05).id).toBe("0.05:26.15:91.75");
    expect(snapCell(26.1, 91.7, 0.05).id).toBe("0.05:26.10:91.70");
  });

  it("gives one key per data source, latitude first", () => {
    const cells = snapPoint(19.076, 72.8777);

    expect(cells.historical).toMatchObject({ id: "0.1:19.1:72.9", lat: 19.1, lon: 72.9 });
    expect(cells.climate.id).toBe("0.1:19.1:72.9");
    expect(cells.forecast.id).toBe("0.1:19.1:72.9");
    expect(cells.flood.id).toBe("0.05:19.10:72.90");
  });

  it("puts nearby points in the same cell", () => {
    expect(snapPoint(26.16, 91.76)).toEqual(snapPoint(26.17, 91.77));
  });

  it("splits points on either side of a cell boundary", () => {
    expect(snapPoint(26.14, 91.74).historical.id).toBe("0.1:26.1:91.7");
    expect(snapPoint(26.16, 91.76).historical.id).toBe("0.1:26.2:91.8");
  });
});

describe("parseCellId", () => {
  it("accepts canonical ids", () => {
    expect(parseCellId("0.05:26.15:91.75")).toMatchObject({ lat: 26.15, lon: 91.75 });
    expect(parseCellId("0.1:26.1:91.7")).toMatchObject({ resolution: 0.1 });
  });

  it.each([
    ["off-grid centre", "0.05:26.13:91.75"],
    ["unknown resolution", "0.2:26.2:91.8"],
    ["wrong precision", "0.05:26.1:91.7"],
    ["path traversal", "../../etc/passwd"],
    ["sql fragment", "0.1:26.1:91.7'; DROP TABLE points;--"],
    ["empty", ""],
  ])("rejects %s", (_name, id) => {
    expect(parseCellId(id)).toBeNull();
  });
});
