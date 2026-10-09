import type { Clock } from "../ports.js";

export const systemClock: Clock = { now: () => new Date() };

// A clock that only moves when told to, for tests and the simulator
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(to: Date | string): void {
    this.current = new Date(to);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }
}
