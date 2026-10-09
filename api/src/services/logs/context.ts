import { AsyncLocalStorage } from "node:async_hooks";

export type LogFields = Record<string, unknown>;

// Fields every line written inside a request (or a monitor tick) carries,
// without passing them down through every service
const storage = new AsyncLocalStorage<LogFields>();

export function withLogContext<T>(fields: LogFields, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export function logContext(): LogFields | undefined {
  return storage.getStore();
}
