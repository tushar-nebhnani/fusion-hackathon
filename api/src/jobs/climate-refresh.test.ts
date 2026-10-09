import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startClimateRefresh } from "./climate-refresh.js";

const SIX_HOURS = 6 * 3_600_000;
const logger = { info: vi.fn(), error: vi.fn() };

describe("climate refresh job", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logger.info.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every 6 hours by default, and not at start-up", async () => {
    const refreshAll = vi.fn(() => Promise.resolve({ points: 3, failed: 1 }));
    const job = startClimateRefresh({ refreshAll }, { logger });

    expect(refreshAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SIX_HOURS - 1);
    expect(refreshAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("climate refresh: 2 of 3 locations updated");

    await vi.advanceTimersByTimeAsync(2 * SIX_HOURS);
    expect(refreshAll).toHaveBeenCalledTimes(3);
    job.stop();
  });

  it("keeps running after a failed run", async () => {
    const refreshAll = vi
      .fn<() => Promise<{ points: number; failed: number }>>()
      .mockRejectedValueOnce(new Error("database is down"))
      .mockResolvedValue({ points: 1, failed: 0 });
    const job = startClimateRefresh({ refreshAll }, { logger });

    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(logger.error).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(refreshAll).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("does not start a second run while one is still going", async () => {
    let finish: () => void = () => undefined;
    const refreshAll = vi.fn(
      () =>
        new Promise<{ points: number; failed: number }>((resolve) => {
          finish = () => resolve({ points: 1, failed: 0 });
        }),
    );
    const job = startClimateRefresh({ refreshAll }, { intervalMs: 1000, logger });

    await vi.advanceTimersByTimeAsync(3000);
    expect(refreshAll).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshAll).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("stops when asked", async () => {
    const refreshAll = vi.fn(() => Promise.resolve({ points: 0, failed: 0 }));
    const job = startClimateRefresh({ refreshAll }, { logger });

    job.stop();
    await vi.advanceTimersByTimeAsync(3 * SIX_HOURS);

    expect(refreshAll).not.toHaveBeenCalled();
  });
});
