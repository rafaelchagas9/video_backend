import { describe, expect, test } from "bun:test";
import { serializeLoggerError } from "@/utils/logger";

describe("logger error serialization", () => {
  test("preserves the error type, message, and stack", () => {
    const error = new TypeError("conversion failed");
    const serialized = serializeLoggerError(error);

    expect(serialized.type).toBe("TypeError");
    expect(serialized.message).toBe("conversion failed");
    expect(serialized.stack).toContain("TypeError: conversion failed");
    expect(serialized.stack).toContain("logger-serialization.test.ts");
  });
});
