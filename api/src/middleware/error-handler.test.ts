import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../errors/app-error.js";
import { errorHandler, notFoundHandler } from "./error-handler.js";

function buildApp(handler = errorHandler): Express {
  const app = express();
  app.use(express.json());
  app.get("/ok", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/conflict", () => {
    throw new ConflictError("Email already used", { field: "email" });
  });
  app.get("/async-conflict", async () => {
    await Promise.resolve();
    throw new ConflictError("Email already used");
  });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.post("/echo", (req, res) => {
    res.json(req.body);
  });
  app.use(notFoundHandler);
  app.use(handler);
  return app;
}

describe("error handling middleware", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("leaves successful responses untouched", async () => {
    const res = await request(buildApp()).get("/ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("serialises an AppError with its status, code and details", async () => {
    const res = await request(buildApp()).get("/conflict");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: "CONFLICT",
        message: "Email already used",
        details: { field: "email" },
      },
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("handles errors thrown from async handlers", async () => {
    const res = await request(buildApp()).get("/async-conflict");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(buildApp()).get("/missing");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "Route GET /missing not found" },
    });
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("content-type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("returns 500 and logs unexpected errors", async () => {
    const res = await request(buildApp()).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "kaboom" },
    });
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("hides unexpected error messages in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const production = await import("./error-handler.js");

    const res = await request(buildApp(production.errorHandler)).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
});
