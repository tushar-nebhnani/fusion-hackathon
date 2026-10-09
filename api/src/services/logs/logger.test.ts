import { describe, expect, it } from "vitest";
import { loadLogsEnv } from "./config.js";
import { withLogContext } from "./context.js";
import { createLogger, formatPretty, istTimestamp, type LogRecord } from "./logger.js";
import { memoryLogger } from "./testing.js";

describe("logger", () => {
  it("writes a structured line with an IST timestamp", () => {
    const { logger, records } = memoryLogger("api");

    logger.info("API listening", { port: 4000 });

    expect(records).toEqual([
      {
        time: "2026-10-09T11:30:00.000+05:30",
        level: "info",
        service: "api",
        msg: "API listening",
        detail: { port: 4000 },
      },
    ]);
  });

  it("drops lines below its level", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ service: "api", level: "warn", sink: (r) => records.push(r) });

    logger.debug("a");
    logger.info("b");
    logger.log("c");
    logger.warn("d");
    logger.error("e");

    expect(records.map((r) => r.msg)).toEqual(["d", "e"]);
  });

  it("writes nothing when silent", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ service: "api", level: "silent", sink: (r) => records.push(r) });

    logger.error("x");

    expect(records).toEqual([]);
  });

  it("keeps an error's name, message, code and stack apart from the detail", () => {
    const { logger, records } = memoryLogger();
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    logger.error("climate: archive failed", error, "cell 19.1:72.9");

    expect(records[0]?.detail).toBe("cell 19.1:72.9");
    expect(records[0]?.err).toMatchObject({
      name: "Error",
      message: "connect ECONNREFUSED",
      code: "ECONNREFUSED",
      stack: expect.stringContaining("connect ECONNREFUSED") as unknown,
    });
  });

  it("never writes a secret, however deep", () => {
    const { logger, records } = memoryLogger();

    logger.child({ sessionToken: "abc" }).warn("auth", {
      user: { id: "u1", password: "p" },
      headers: { Authorization: "Bearer x", cookie: "fusion_session=y" },
      OPENAI_API_KEY: "sk-z",
      smtp: { appPassword: "q" },
    });

    const line = JSON.stringify(records[0]);
    for (const secret of ["abc", '"p"', "Bearer x", "fusion_session=y", "sk-z", '"q"']) {
      expect(line).not.toContain(secret);
    }
    expect(records[0]?.detail).toMatchObject({ user: { id: "u1", password: "[redacted]" } });
  });

  it("copes with cycles, bigints, dates and deep objects", () => {
    const { logger, records } = memoryLogger();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };

    logger.info("odd", { loop, big: 10n, at: new Date("2026-10-09T00:00:00Z"), deep });

    expect(records[0]?.detail).toMatchObject({
      loop: { name: "loop", self: "[circular]" },
      big: "10",
      at: "2026-10-09T05:30:00.000+05:30",
    });
    expect(JSON.stringify(records[0])).toContain("[truncated]");
  });

  it("does not throw when the sink does", () => {
    const logger = createLogger({
      service: "api",
      sink: () => {
        throw new Error("disk full");
      },
    });

    expect(() => logger.error("x")).not.toThrow();
  });

  it("adds a child's fields to every line, without overwriting the record's own", () => {
    const { logger, records } = memoryLogger("api");
    const climate = logger.child({ component: "climate", level: "nope", msg: "nope" });

    climate.child({ cell: "19.1:72.9" }).warn("projections failed");

    expect(records[0]).toMatchObject({
      level: "warn",
      msg: "projections failed",
      component: "climate",
      cell: "19.1:72.9",
    });
  });

  it("carries the context's fields across awaits", async () => {
    const { logger, records } = memoryLogger();

    await withLogContext({ requestId: "r1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info("inside");
    });
    logger.info("outside");

    expect(records[0]).toMatchObject({ msg: "inside", requestId: "r1" });
    expect(records[1]).not.toHaveProperty("requestId");
  });

  it("formats a readable line for a terminal", () => {
    const line = formatPretty({
      time: "2026-10-09T11:30:00.000+05:30",
      level: "warn",
      service: "monitor",
      msg: "tick slow",
      cell: "19.1:72.9",
      detail: { ms: 900 },
      err: { name: "Error", message: "boom" },
    });

    expect(line).toBe(
      '2026-10-09T11:30:00.000+05:30 WARN  monitor tick slow cell=19.1:72.9 {"ms":900}\n  Error: boom',
    );
  });

  it("stamps IST at the date line", () => {
    expect(istTimestamp(new Date("2026-10-09T18:30:00Z"))).toBe("2026-10-10T00:00:00.000+05:30");
  });
});

describe("log settings", () => {
  it("defaults to info, pretty in development and json in production", () => {
    expect(loadLogsEnv({})).toEqual({ level: "info", format: "pretty", dbLevel: "info" });
    expect(loadLogsEnv({ NODE_ENV: "production" })).toEqual({ level: "info", format: "json", dbLevel: "info" });
  });

  it("falls back to the defaults on a bad value instead of stopping", () => {
    expect(loadLogsEnv({ LOG_LEVEL: "loud", LOG_FORMAT: "xml" })).toEqual({ level: "info", format: "pretty", dbLevel: "info" });
    expect(loadLogsEnv({ LOG_LEVEL: "debug", LOG_FORMAT: "json" })).toEqual({ level: "debug", format: "json", dbLevel: "info" });
  });
});
