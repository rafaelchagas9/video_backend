import { describe, expect, test } from "bun:test";
import { mapScanLogToRun } from "@/modules/directories/directory-scans.service";

function row(errors: string | null, completedAt: Date | null = new Date("2026-01-01T00:00:01.000Z")) {
  return {
    id: 7,
    directoryId: 3,
    filesFound: 4,
    filesAdded: 1,
    filesUpdated: 2,
    filesRemoved: 1,
    errors,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt,
  };
}

describe("directory scan read model", () => {
  test("represents running and zero-error completed runs", () => {
    expect(mapScanLogToRun(row(null, null))).toMatchObject({
      status: "running",
      error_count: 0,
      completed_at: null,
    });
    expect(mapScanLogToRun(row("[]"))).toMatchObject({
      status: "completed",
      files_found: 4,
      error_count: 0,
    });
  });

  test("treats invalid legacy JSON as one safe summary", () => {
    const run = mapScanLogToRun(row("not-json"));
    expect(run.error_count).toBe(1);
    expect(run.error_summaries).toEqual(["not-json"]);
  });

  test("bounds and redacts public error summaries", () => {
    const errors = [
      "/home/user/private/movie.mkv: failed",
      ...Array.from({ length: 6 }, (_, index) => `error-${index}`),
    ];
    const run = mapScanLogToRun(row(JSON.stringify(errors)));
    expect(run.status).toBe("completed");
    expect(run.error_count).toBe(7);
    expect(run.error_summaries).toHaveLength(5);
    expect(JSON.stringify(run)).not.toContain("/home/user/private/movie.mkv");
    expect(JSON.stringify(run)).not.toContain("movie.mkv");
  });
});
