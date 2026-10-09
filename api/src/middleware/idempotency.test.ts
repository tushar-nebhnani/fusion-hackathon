import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "./error-handler.js";
import { createMemoryIdempotencyStore, idempotency, IDEMPOTENCY } from "./idempotency.js";

function buildApp(options: { required?: boolean; now?: () => Date } = {}) {
  const calls = vi.fn();
  let release: () => void = () => {};
  const app: Express = express();
  app.use(express.json());
  app.use(
    idempotency(createMemoryIdempotencyStore(), { ...options, logger: { error: vi.fn() } }),
  );
  app.post("/orders", (req, res) => {
    calls();
    res.status(201).json({ id: calls.mock.calls.length, item: (req.body as { item: string }).item });
  });
  app.get("/orders", (_req, res) => {
    calls();
    res.json({ count: calls.mock.calls.length });
  });
  app.post("/slow", async (_req, res) => {
    calls();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    res.json({ done: true });
  });
  app.post("/flaky", (_req, res) => {
    calls();
    res.status(calls.mock.calls.length === 1 ? 503 : 200).json({ attempt: calls.mock.calls.length });
  });
  app.use(errorHandler);
  return { app, calls, release: () => release() };
}

describe("idempotency middleware", () => {
  it("runs the handler once and replays the stored response", async () => {
    const { app, calls } = buildApp();

    const first = await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });
    const second = await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });

    expect(first.status).toBe(201);
    expect(first.headers).not.toHaveProperty("idempotency-replayed");
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("treats different keys as different requests", async () => {
    const { app, calls } = buildApp();

    await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });
    await request(app).post("/orders").set("Idempotency-Key", "k2").send({ item: "a" });

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("rejects a key reused with a different body", async () => {
    const { app, calls } = buildApp();

    await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });
    const res = await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "b" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("answers 409 while the first request is still running", async () => {
    const { app, calls, release } = buildApp();

    const first = request(app).post("/slow").set("Idempotency-Key", "k1").send({}).then((r) => r);
    await vi.waitFor(() => {
      expect(calls).toHaveBeenCalledTimes(1);
    });
    const second = await request(app).post("/slow").set("Idempotency-Key", "k1").send({});
    release();

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: "IDEMPOTENCY_IN_PROGRESS" } });
    expect((await first).status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("does not store server errors, so a retry runs again", async () => {
    const { app, calls } = buildApp();

    const first = await request(app).post("/flaky").set("Idempotency-Key", "k1").send({});
    const second = await request(app).post("/flaky").set("Idempotency-Key", "k1").send({});

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("runs the request again once the stored response has expired", async () => {
    let clock = new Date("2026-10-09T06:00:00Z");
    const { app, calls } = buildApp({ now: () => clock });

    await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });
    clock = new Date(clock.getTime() + IDEMPOTENCY.ttlMs + 1);
    const res = await request(app).post("/orders").set("Idempotency-Key", "k1").send({ item: "a" });

    expect(res.headers).not.toHaveProperty("idempotency-replayed");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("leaves safe methods and requests without a key alone", async () => {
    const { app, calls } = buildApp();

    await request(app).get("/orders").set("Idempotency-Key", "k1");
    await request(app).get("/orders").set("Idempotency-Key", "k1");
    await request(app).post("/orders").send({ item: "a" });
    await request(app).post("/orders").send({ item: "a" });

    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("rejects a malformed key", async () => {
    const { app, calls } = buildApp();

    const res = await request(app).post("/orders").set("Idempotency-Key", "has space").send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    expect(calls).not.toHaveBeenCalled();
  });

  it("can require the key on unsafe methods", async () => {
    const { app } = buildApp({ required: true });

    const missing = await request(app).post("/orders").send({ item: "a" });
    const safe = await request(app).get("/orders");

    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: "MISSING_IDEMPOTENCY_KEY" } });
    expect(safe.status).toBe(200);
  });
});
