import type { RunLogger } from "./ports.js";

export interface LoopDeps {
  tick: () => Promise<unknown>;
  tickMs: number;
  logger: RunLogger;
  // Test seams; the defaults are the wall clock and a real timer
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Loop {
  // Ticks until stop() is called
  run(): Promise<void>;
  stop(): void;
}

// One awaited loop, not a setInterval: a tick is never started while the
// previous one is running. Ticks that came due in the meantime are skipped,
// not queued. Which cells are due is stored in the database, so nothing is
// lost by skipping.
export function createLoop(deps: LoopDeps): Loop {
  const now = deps.now ?? Date.now;
  let stopping = false;
  let wake: () => void = () => undefined;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }));

  async function run(): Promise<void> {
    let due = now();
    while (!stopping) {
      try {
        await deps.tick();
      } catch (error) {
        deps.logger.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopping) break;

      const at = now();
      let skipped = -1;
      do {
        due += deps.tickMs;
        skipped += 1;
      } while (due <= at);
      if (skipped > 0) {
        deps.logger.warn(`the last tick overran; ${skipped} tick${skipped === 1 ? "" : "s"} skipped`);
      }
      await sleep(due - at);
    }
  }

  return {
    run,
    stop() {
      stopping = true;
      wake();
    },
  };
}
