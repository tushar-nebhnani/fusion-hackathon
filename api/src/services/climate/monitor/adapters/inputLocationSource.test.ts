import { describe, expect, it } from "vitest";
import { memoryLogger } from "../testing/fixtures.js";
import { createInputLocationSource } from "./inputLocationSource.js";

describe("input location source", () => {
  it("watches each business with a live loan at its primary location", async () => {
    const source = createInputLocationSource(
      () =>
        Promise.resolve([
          { business_id: "b-1", lat: 13.0827, lon: 80.2707 },
          { business_id: "b-2", lat: 26.1445, lon: 91.7362 },
        ]),
      memoryLogger().logger,
    );

    expect(await source.list()).toEqual([
      { locationId: "b-1", businessId: "b-1", lat: 13.0827, lon: 80.2707 },
      { locationId: "b-2", businessId: "b-2", lat: 26.1445, lon: 91.7362 },
    ]);
  });

  it("skips a location outside coverage and carries on", async () => {
    const log = memoryLogger();
    const source = createInputLocationSource(
      () =>
        Promise.resolve([
          { business_id: "abroad", lat: 51.5, lon: -0.12 },
          { business_id: "b-1", lat: 13.0827, lon: 80.2707 },
        ]),
      log.logger,
    );

    expect((await source.list()).map((l) => l.businessId)).toEqual(["b-1"]);
    expect(log.of("warn")[0]).toContain("business abroad skipped");
  });

  it("lets a database failure reach the loop, which logs it and tries next tick", async () => {
    const source = createInputLocationSource(
      () => Promise.reject(new Error("db down")),
      memoryLogger().logger,
    );
    await expect(source.list()).rejects.toThrow("db down");
  });
});
