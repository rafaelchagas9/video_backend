import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  AppError,
  ConflictError,
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
});
