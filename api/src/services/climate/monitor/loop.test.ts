import { describe, expect, it } from "vitest";
import { createLoop } from "./loop.js";
import { memoryLogger } from "./testing/fixtures.js";

const TICK_MS = 15 * 60_000;

// A loop on a fake wall clock: each tick takes `durations[n]`, and the loop
// is stopped once every scripted tick has run
function setup(durations: number[], failing: number[] = []) {
  let now = 0;
  let running = 0;
  let overlapped = false;
  const started: number[] = [];
  const sleeps: number[] = [];
  const log = memoryLogger();
  const loop = createLoop({
    tickMs: TICK_MS,
    logger: log.logger,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    tick: async () => {
      if (running > 0) overlapped = true;
      running += 1;
      const index = started.length;
      started.push(now);
      await Promise.resolve();
      now += durations[index] ?? 0;
      running -= 1;
      if (started.length >= durations.length) loop.stop();
      if (failing.includes(index)) throw new Error("database is down");
    },
  });
  return { loop, started, sleeps, log, overlapped: () => overlapped };
}

describe("monitor loop", () => {
  it("ticks at once, then every interval measured from the tick's start", async () => {
    const { loop, started, sleeps } = setup([60_000, 60_000, 60_000]);

    await loop.run();

    expect(started).toEqual([0, TICK_MS, 2 * TICK_MS]);
    expect(sleeps).toEqual([TICK_MS - 60_000, TICK_MS - 60_000]);
  });

  it("skips the ticks that came due while a slow one was running", async () => {
    // The first tick takes two and a half intervals
    const { loop, started, log, overlapped } = setup([2.5 * TICK_MS, 0]);

    await loop.run();

    expect(started).toEqual([0, 3 * TICK_MS]);
    expect(log.of("warn")).toEqual(["the last tick overran; 2 ticks skipped"]);
    expect(overlapped()).toBe(false);
  });

  it("never runs two ticks at once", async () => {
    const { loop, overlapped, started } = setup([TICK_MS, 3 * TICK_MS, 10, TICK_MS * 1.5, 0]);

    await loop.run();

    expect(started).toHaveLength(5);
    expect(overlapped()).toBe(false);
  });

  it("logs a failed tick and carries on", async () => {
    const { loop, started, log } = setup([0, 0, 0], [0]);

    await loop.run();

    expect(started).toHaveLength(3);
    expect(log.of("error")).toEqual(["tick failed: database is down"]);
  });

  it("stops waiting as soon as it is told to", async () => {
    const log = memoryLogger();
    let ticks = 0;
    const loop = createLoop({
      tickMs: 60 * 60_000,
      logger: log.logger,
      tick: () => {
        ticks += 1;
        return Promise.resolve();
      },
    });

    const running = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    loop.stop();
    await running;

    expect(ticks).toBe(1);
  });
});
