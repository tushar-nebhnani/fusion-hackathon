import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { AuditOutcome, AuditRecorder } from "../services/audit/recorder.js";
import { sessionUser } from "./auth.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_PATH_CHARS = 120;

interface AuditNote {
  // Who the request turned out to be from, when there was no session (sign-in)
  actor?: { id: string; role: string };
  // The record the request is about
  target?: { type: string; id: string };
}

// For a handler to say what its request is about. Notes add up.
export function auditNote(res: Response, note: AuditNote): void {
  res.locals.audit = { ...(res.locals.audit as AuditNote | undefined), ...note };
}

// The route as it was declared, under the path it is mounted at:
// "/climate/profile", "/businesses/:id/locations". Ids stay out of it.
function routePattern(path: string, route: string): string {
  const requested = path.split("/").filter(Boolean);
  const declared = route.split("/").filter(Boolean);
  const mount = requested.slice(0, Math.max(requested.length - declared.length, 0));
  return `/${[...mount, ...declared].join("/")}`;
}

function outcomeOf(status: number): AuditOutcome {
  if (status < 400) return "success";
  return status === 401 || status === 403 ? "denied" : "failure";
}

// Gives every request an id, returned as X-Request-Id, and records one audit
// event for each write, each refusal (401, 403) and each failed attempt to
// reach a record. Plain reads and rate-limited requests are not recorded.
// Without a recorder only the id is set.
export function auditTrail(recorder?: AuditRecorder): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set("X-Request-Id", requestId);

    if (recorder) {
      res.on("finish", () => {
        const status = res.statusCode;
        const note = res.locals.audit as AuditNote | undefined;
        const refused = status === 401 || status === 403 || (status === 404 && note?.target !== undefined);
        // A rate-limited request ran nothing, and must not be a way to fill the table
        if (status === 429 || (!UNSAFE_METHODS.has(req.method) && !refused)) return;

        const route = (req.route as { path?: unknown } | undefined)?.path;
        const requested = (req.originalUrl.split("?")[0] ?? "").slice(0, MAX_PATH_CHARS);
        // Without a route the request was refused before one matched
        const path = typeof route === "string" ? routePattern(requested, route) : requested;
        const actor = note?.actor ?? sessionUser(res);
        const errorCode: unknown = res.locals.errorCode;
        const replayed = res.getHeader("Idempotency-Replayed") !== undefined;

        recorder.record({
          requestId,
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          action: `${req.method} ${path}`,
          targetType: note?.target?.type ?? null,
          targetId: note?.target?.id ?? null,
          outcome: outcomeOf(status),
          status,
          reason: typeof errorCode === "string" ? errorCode : replayed ? "IDEMPOTENT_REPLAY" : null,
        });
      });
    }
    next();
  };
}
