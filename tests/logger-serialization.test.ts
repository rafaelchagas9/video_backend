import { describe, expect, test } from "bun:test";
import { serializeLoggerError } from "@/utils/logger";
import { DrizzleQueryError } from "drizzle-orm/errors";

describe("logger error serialization", () => {
  test("preserves the error type, message, and stack", () => {
    const error = new TypeError("conversion failed");
    const serialized = serializeLoggerError(error);

    expect(serialized.type).toBe("TypeError");
    expect(serialized.message).toBe("conversion failed");
    expect(serialized.stack).toContain("TypeError: conversion failed");
    expect(serialized.stack).toContain("logger-serialization.test.ts");
  });

  test("bounds embedding query logs and preserves the database cause", () => {
    const cause = Object.assign(new Error("connection terminated"), {
      code: "CONNECTION_CLOSED",
    });
    const parameter = "[-0.012345,0.043210,".repeat(100_000);
    const error = new DrizzleQueryError(
      "INSERT INTO video_frame_embeddings VALUES ($1::halfvec)",
      [parameter],
      cause
    );
    const serialized = serializeLoggerError(error);
    expect(serialized.message.length).toBeLessThanOrEqual(4_096);
    expect(serialized.stack.length).toBeLessThanOrEqual(16_384);
    expect(serialized.params).toBe("[omitted 1 query parameters]");
    expect(serialized.causeDetails).toEqual({
      type: "Error",
      message: "connection terminated",
      code: "CONNECTION_CLOSED",
    });
    expect(JSON.stringify(serialized).length).toBeLessThan(22_000);
    expect(error.params[0]).toBe(parameter);
  });
});
