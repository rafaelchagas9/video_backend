import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  AppError,
  ConflictError,
  getPostgresErrorCode,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from "@/utils/errors";
import {
  idParamSchema,
  paginationSchema,
  validateSchema,
} from "@/utils/validation";

describe("validation utilities", () => {
  it("returns parsed and coerced data for valid input", () => {
    const schema = z.object({
      id: z.coerce.number().int().positive(),
      enabled: z.boolean().default(true),
    });

    expect(validateSchema(schema, { id: "42" })).toEqual({
      id: 42,
      enabled: true,
    });
  });

  it("throws a ValidationError with field-level details", () => {
    const schema = z.object({
      name: z.string().min(3),
      count: z.number().int().positive(),
    });

    expect(() => validateSchema(schema, { name: "ab", count: -1 })).toThrow(
      ValidationError,
    );

    try {
      validateSchema(schema, { name: "ab", count: -1 });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).statusCode).toBe(400);
      expect((error as ValidationError).message).toContain("name:");
      expect((error as ValidationError).message).toContain("count:");
    }
  });

  it("coerces standard pagination and id parameters", () => {
    expect(paginationSchema.parse({ page: "2", limit: "50" })).toEqual({
      page: 2,
      limit: 50,
    });
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(idParamSchema.parse({ id: "12" })).toEqual({ id: 12 });
  });

  it("preserves custom error prototypes and status codes", () => {
    const notFound = new NotFoundError("Missing video");
    const conflict = new ConflictError("Duplicate video");

    expect(notFound).toBeInstanceOf(Error);
    expect(notFound).toBeInstanceOf(AppError);
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound.statusCode).toBe(404);

    expect(conflict).toBeInstanceOf(Error);
    expect(conflict).toBeInstanceOf(AppError);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.isOperational).toBe(true);
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
      isUniqueViolation(
        Object.assign(new Error("other"), { code: "23503" }),
      ),
    ).toBe(false);
  });

  it("does not loop forever on a self-referential cause chain", () => {
    const error: any = new Error("circular");
    error.cause = error;

    expect(getPostgresErrorCode(error)).toBeUndefined();
    expect(isUniqueViolation(error)).toBe(false);
  });
});
