import { describe, expect, it } from "vitest";
import { AppError } from "../../errors/app-error.js";
import { createNewPlaceGate } from "./new-place-gate.js";

describe("new place gate", () => {
  it("allows each user their own few new places per window, then 429", () => {
    let clock = 0;
    const gate = createNewPlaceGate({ perUser: 2, windowMs: 60_000, now: () => clock });

    gate.take("asha");
    gate.take("asha");
    gate.take("ravi");

    let refused: unknown;
    try {
      gate.take("asha");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ statusCode: 429, code: "NEW_PLACE_LIMIT", details: { retry_after_seconds: 60 } });

    clock = 60_000;
    expect(() => gate.take("asha")).not.toThrow();
  });

  it("never counts work nobody asked for (warming, refresh, monitor)", () => {
    const gate = createNewPlaceGate({ perUser: 1, windowMs: 60_000, now: () => 0 });

    for (let n = 0; n < 10; n += 1) expect(() => gate.take(null)).not.toThrow();
  });
});
