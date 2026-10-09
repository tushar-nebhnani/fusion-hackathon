import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../services/logs/testing.js";
import { auditTrail } from "./audit.js";
import { errorHandler } from "./error-handler.js";
import { requestLog } from "./request-log.js";
import { NotFoundError } from "../errors/app-error.js";

function setup() {
  const { logger, records } = memoryLogger("api");
  const app = express();
  app.use(auditTrail());
  app.use(requestLog(logger));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/work", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    logger.child({ component: "climate" }).warn("upstream slow");
    res.json({ ok: true });
  });
  app.get("/refused", () => {
    throw new NotFoundError("No such business");
  });
  app.get("/broken", () => {
    throw new Error("boom");
  });
  app.use(errorHandler);
  return { app, records };
}

describe("request log", () => {
  it("writes one line per request, without the query string", async () => {
    const { app, records } = setup();

    const res = await request(app).get("/work?lat=19.07&lon=72.87&token=t");

    const line = records.find((r) => r.msg === "request");
    expect(line).toMatchObject({
      level: "info",
      requestId: res.headers["x-request-id"],
      method: "GET",
      path: "/work",
      status: 200,
    });
    expect(typeof line?.ms).toBe("number");
    expect(JSON.stringify(records)).not.toContain("lat=");
  });

  it("puts the request id on lines logged inside the handler", async () => {
    const { app, records } = setup();

    const res = await request(app).get("/work");

    expect(records.find((r) => r.msg === "upstream slow")).toMatchObject({
      requestId: res.headers["x-request-id"],
      component: "climate",
    });
  });

  it("warns on a refusal and records its error code", async () => {
    const { app, records } = setup();

    await request(app).get("/refused");

    expect(records.find((r) => r.msg === "request")).toMatchObject({
      level: "warn",
      status: 404,
      errorCode: "NOT_FOUND",
    });
  });

  it("logs a server error at error", async () => {
    const { app, records } = setup();

    await request(app).get("/broken");

    expect(records.find((r) => r.msg === "request")).toMatchObject({
      level: "error",
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("keeps health checks at debug", async () => {
    const { app, records } = setup();

    await request(app).get("/health");

    expect(records.filter((r) => r.msg === "request").map((r) => r.level)).toEqual(["debug"]);
  });
});
