import type { Redis } from "ioredis";

// Runs `job` unless another instance already ran it in this interval.
// Resolves to whether it ran here.
export type OncePerInterval = (name: string, intervalMs: number, job: () => Promise<void>) => Promise<boolean>;

// For one process, and for tests: every tick runs
export const everyTick: OncePerInterval = async (_name, _intervalMs, job) => {
  await job();
  return true;
};

// Share of the interval a claim is held for. Less than the whole of it, so
// that the instance whose timer fires a little early next time is not refused.
const HOLD = 0.9;

// With several API instances each one has the same timers. The first to
// tick claims the interval in Redis and runs the job; the others skip it.
// The claim is not released when the job ends, or an instance ticking a
// moment later would run it again. If Redis is unreachable the job runs
// anyway: doing the work twice is better than not doing it.
export function createOncePerInterval(
  redis: Redis,
  options: { prefix?: string; logger?: Pick<Console, "warn"> } = {},
): OncePerInterval {
  const prefix = options.prefix ?? "fusion:job:";
  const logger = options.logger ?? console;

  return async (name, intervalMs, job) => {
    let claimed: string | null;
    try {
      claimed = await redis.set(prefix + name, "1", "PX", Math.max(1, Math.floor(intervalMs * HOLD)), "NX");
    } catch (error) {
      logger.warn(
        `jobs: Redis is unavailable, running "${name}" without checking other instances,`,
        error instanceof Error ? error.message : error,
      );
      claimed = "OK";
    }
    if (claimed !== "OK") return false;
    await job();
    return true;
  };
}
