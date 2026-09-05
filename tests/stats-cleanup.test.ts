import { beforeEach, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = mock(async (_query: SQL) => Object.assign([], { count: 0 }));
const info = mock(() => {});
mock.module("@/config/drizzle", () => ({ db: { execute } }));
mock.module("@/utils/logger", () => ({ logger: { info } }));

const { StatsCleanupService } =
  await import("@/modules/stats/stats.cleanup.service");

beforeEach(() => {
  execute.mockReset();
  info.mockClear();
});

test("reports deleted rows from postgres-js metadata even without RETURNING", async () => {
  for (const count of [3, 2, 0, 7]) {
    execute.mockResolvedValueOnce(Object.assign([], { count }));
  }

  const result = await new StatsCleanupService().cleanupOldSnapshots(45, 180);

  expect(result).toEqual({
    storageDeleted: 3,
    libraryDeleted: 2,
    contentDeleted: 0,
    usageDeleted: 7,
  });
  expect(info).toHaveBeenCalledWith(result, "Old stats snapshots cleaned up");
  const dialect = new PgDialect();
  expect(
    execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).params)
  ).toEqual([[45], [180], [180], [180]]);
});

test("does not announce cleanup when no snapshots expired", async () => {
  execute.mockResolvedValue(Object.assign([], { count: 0 }));

  expect(await new StatsCleanupService().cleanupOldSnapshots()).toEqual({
    storageDeleted: 0,
    libraryDeleted: 0,
    contentDeleted: 0,
    usageDeleted: 0,
  });
  expect(info).not.toHaveBeenCalled();
});
