import { describe, expect, it } from "bun:test";
import {
  AppError,
  ConflictError,
  getPostgresErrorCode,
  getHttpErrorStatusCode,
  InternalServerError,
  isUniqueViolation,
  NotFoundError,
  shouldCaptureHttpError,
} from "@/utils/errors";

describe("error utilities", () => {
  it("preserves custom error prototypes and status codes", () => {
    const notFound = new NotFoundError("Missing video");
    const conflict = new ConflictError("Duplicate video");

    expect(notFound).toBeInstanceOf(Error);
    expect(notFound).toBeInstanceOf(AppError);
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.name).toBe("NotFoundError");

    expect(conflict).toBeInstanceOf(Error);
    expect(conflict).toBeInstanceOf(AppError);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.isOperational).toBe(true);
    expect(conflict.name).toBe("ConflictError");
  });

  it("preserves plugin status codes and captures only server failures", () => {
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), {
      statusCode: 429,
    });
    const cause = new Error("ffmpeg spawn failed");
    const internal = new InternalServerError("Rendering failed", { cause });

    expect(getHttpErrorStatusCode(rateLimitError)).toBe(429);
    expect(shouldCaptureHttpError(rateLimitError)).toBe(false);
    expect(getHttpErrorStatusCode(internal)).toBe(500);
    expect(shouldCaptureHttpError(internal)).toBe(true);
    expect(internal.name).toBe("InternalServerError");
    expect(internal.isOperational).toBe(false);
    expect(internal.cause).toBe(cause);
    expect(getHttpErrorStatusCode(new Error("boom"))).toBe(500);
  });

  it("extracts a postgres error code from the top-level error", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });

    expect(getPostgresErrorCode(error)).toBe("23505");
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("extracts a postgres error code wrapped in a drizzle cause chain", () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const drizzleError = Object.assign(new Error("Failed query"), {
      cause: pgError,
    });

    expect(getPostgresErrorCode(drizzleError)).toBe("23505");
    expect(isUniqueViolation(drizzleError)).toBe(true);
  });

  it("returns undefined / false for unrelated errors", () => {
    expect(getPostgresErrorCode(new Error("boom"))).toBeUndefined();
    expect(getPostgresErrorCode(undefined)).toBeUndefined();
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(
      isUniqueViolation(Object.assign(new Error("other"), { code: "23503" }))
    ).toBe(false);
  });

  it("does not loop forever on a self-referential cause chain", () => {
    const error: any = new Error("circular");
    error.cause = error;

    expect(getPostgresErrorCode(error)).toBeUndefined();
    expect(isUniqueViolation(error)).toBe(false);
  });
});
