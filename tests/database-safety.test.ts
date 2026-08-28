import { describe, expect, it } from "bun:test";
import {
  assertSafeTestDatabaseTarget,
  guardDatabaseAccess,
} from "@/config/database-safety";

describe("PostgreSQL test isolation", () => {
  const disposableTarget = {
    host: "127.0.0.1",
    port: 49152,
    database: "conversor_video_test",
    user: "test_user",
  };

  it("allows the disposable integration database in test mode", () => {
    expect(() =>
      assertSafeTestDatabaseTarget(disposableTarget, "test"),
    ).not.toThrow();
  });

  it("refuses the main database in test mode", () => {
    expect(() =>
      assertSafeTestDatabaseTarget(
        {
          host: "localhost",
          port: 5432,
          database: "video_streaming_db",
          user: "vueverse",
        },
        "test",
      ),
    ).toThrow("Test-mode PostgreSQL access refused");
  });

  it("rechecks the connection when a cached client is accessed later", () => {
    let runtimeNodeEnv = "development";
    const database = guardDatabaseAccess(
      { select: () => "queried" },
      {
        host: "localhost",
        port: 5432,
        database: "video_streaming_db",
        user: "vueverse",
      },
      () => runtimeNodeEnv,
    );

    expect(database.select()).toBe("queried");
    runtimeNodeEnv = "test";
    expect(() => database.select()).toThrow(
      "Test-mode PostgreSQL access refused",
    );
  });
});
