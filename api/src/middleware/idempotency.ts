import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

const HOUR_MS = 3_600_000;

export const IDEMPOTENCY = {
  // How long a stored response is replayed for
  ttlMs: 24 * HOUR_MS,
  // How long a request may stay in flight before its key can be taken over
  lockMs: 5 * 60_000,
} as const;

export type BeginResult =
  | { kind: "started" }
  | { kind: "replay"; status: number; body: string }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

export interface IdempotencyStore {
  // Atomically claims the key, or reports what already holds it
  begin(input: {
    scope: string;
    key: string;
    fingerprint: string;
    now: Date;
    lockUntil: Date;
  }): Promise<BeginResult>;
  complete(input: {
    scope: string;
    key: string;
    status: number;
    body: string;
    expiresAt: Date;
  }): Promise<void>;
  // Frees the key so the client can retry
  release(scope: string, key: string): Promise<void>;
}

interface MemoryEntry {
  fingerprint: string;
  response: { status: number; body: string } | null;
  expiresAt: Date;
}

// In-process store for tests and single-instance use
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, MemoryEntry>();
  const id = (scope: string, key: string) => `${scope}\n${key}`;

  return {
    begin({ scope, key, fingerprint, now, lockUntil }) {
      const entry = entries.get(id(scope, key));
      if (!entry || entry.expiresAt <= now) {
        entries.set(id(scope, key), { fingerprint, response: null, expiresAt: lockUntil });
        return Promise.resolve({ kind: "started" });
      }
      if (entry.fingerprint !== fingerprint) return Promise.resolve({ kind: "mismatch" });
      if (!entry.response) return Promise.resolve({ kind: "in_progress" });
      return Promise.resolve({ kind: "replay", ...entry.response });
    },
    complete({ scope, key, status, body, expiresAt }) {
      const entry = entries.get(id(scope, key));
      if (entry) {
        entry.response = { status, body };
        entry.expiresAt = expiresAt;
      }
      return Promise.resolve();
    },
    release(scope, key) {
      entries.delete(id(scope, key));
      return Promise.resolve();
    },
  };
}

export interface IdempotencyOptions {
  // Reject unsafe requests that carry no Idempotency-Key
  required?: boolean;
  now?: () => Date;
  logger?: Pick<Console, "error">;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

// Honours the Idempotency-Key header on unsafe methods: the first request runs
// and its response is stored, repeats with the same key get that response back
// without running again. GET, HEAD and OPTIONS are idempotent already and pass
// straight through. Register after the body parser.
export function idempotency(
  store: IdempotencyStore,
  options: IdempotencyOptions = {},
): RequestHandler {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;

  return async (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const key = req.get("Idempotency-Key");
    if (key === undefined) {
      if (options.required) {
        throw new AppError(
          "Idempotency-Key header is required",
          400,
          "MISSING_IDEMPOTENCY_KEY",
        );
      }
      next();
      return;
    }
    if (!KEY_PATTERN.test(key)) {
      throw new AppError(
        "Idempotency-Key must be 1 to 255 printable ASCII characters without spaces",
        400,
        "INVALID_IDEMPOTENCY_KEY",
      );
    }

    const scope = `${req.method} ${req.baseUrl}${req.path}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([req.originalUrl, (req.body as unknown) ?? null]))
      .digest("hex");
    const at = now();
    const result = await store.begin({
      scope,
      key,
      fingerprint,
      now: at,
      lockUntil: new Date(at.getTime() + IDEMPOTENCY.lockMs),
    });

    if (result.kind === "replay") {
      res
        .status(result.status)
        .set("Idempotency-Replayed", "true")
        .type("json")
        .send(result.body);
      return;
    }
    if (result.kind === "in_progress") {
      throw new AppError(
        "A request with this Idempotency-Key is still being processed",
        409,
        "IDEMPOTENCY_IN_PROGRESS",
      );
    }
    if (result.kind === "mismatch") {
      throw new AppError(
        "This Idempotency-Key was already used with a different request",
        422,
        "IDEMPOTENCY_KEY_REUSED",
      );
    }

    let body: unknown = null;
    const json = res.json.bind(res);
    res.json = (payload?: unknown) => {
      body = payload ?? null;
      return json(payload);
    };

    let settled = false;
    const settle = (action: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      action().catch((error: unknown) => {
        logger.error("idempotency: saving the outcome failed", error);
      });
    };
    // Server errors and rate limits are not stored, so the client can retry
    res.on("finish", () => {
      const status = res.statusCode;
      settle(() =>
        status >= 500 || status === 429
          ? store.release(scope, key)
          : store.complete({
              scope,
              key,
              status,
              body: JSON.stringify(body),
              expiresAt: new Date(now().getTime() + IDEMPOTENCY.ttlMs),
            }),
      );
    });
    res.on("close", () => {
      settle(() => store.release(scope, key));
    });

    next();
  };
}

