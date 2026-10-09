import { describe, expect, it } from "vitest";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./app-error.js";

describe("AppError", () => {
  it("defaults to a 500 internal error", () => {
    const err = new AppError("something broke");

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something broke");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.details).toBeUndefined();
  });

  it("keeps a custom status, code and details", () => {
    const err = new AppError("teapot", 418, "TEAPOT", { hint: "tea" });

    expect(err.statusCode).toBe(418);
    expect(err.code).toBe("TEAPOT");
    expect(err.details).toEqual({ hint: "tea" });
  });
});

describe("AppError subclasses", () => {
  it.each([
    [BadRequestError, 400, "BAD_REQUEST"],
    [UnauthorizedError, 401, "UNAUTHORIZED"],
    [ForbiddenError, 403, "FORBIDDEN"],
    [NotFoundError, 404, "NOT_FOUND"],
    [ConflictError, 409, "CONFLICT"],
  ])("%o maps to %i %s", (ErrorClass, statusCode, code) => {
    const err = new ErrorClass();

    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe(ErrorClass.name);
    expect(err.statusCode).toBe(statusCode);
    expect(err.code).toBe(code);
    expect(err.message).not.toBe("");
  });

  it("accepts a custom message and details", () => {
    const err = new BadRequestError("Invalid latitude", { field: "lat" });

    expect(err.message).toBe("Invalid latitude");
    expect(err.details).toEqual({ field: "lat" });
  });
});
