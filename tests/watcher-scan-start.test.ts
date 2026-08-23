import { describe, expect, spyOn, test } from "bun:test";
import { directoriesService } from "@/modules/directories/directories.service";
import { directoryScansService } from "@/modules/directories/directory-scans.service";
import { WatcherService } from "@/modules/directories/watcher.service";
import type { Directory, ScanRun } from "@/modules/directories/directories.types";

const directory: Directory = {
  id: 41,
  path: "/definitely/missing/scan-fixture",
  is_active: true,
  auto_scan: false,
  scan_interval_minutes: 30,
  last_scan_at: null,
  added_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const runningRun: ScanRun = {
  id: 99,
  directory_id: directory.id,
  status: "running",
  files_found: 0,
  files_added: 0,
  files_updated: 0,
  files_removed: 0,
  error_count: 0,
  error_summaries: [],
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
};

describe("watcher scan start", () => {
  test("reserves before the first await and creates only one open run", async () => {
    let resolveDirectory!: (value: Directory) => void;
    const directoryPromise = new Promise<Directory>((resolve) => {
      resolveDirectory = resolve;
    });
    const findSpy = spyOn(directoriesService, "findById").mockReturnValue(
      directoryPromise
    );
    const createSpy = spyOn(directoryScansService, "create").mockResolvedValue(
      runningRun
    );
    const completeSpy = spyOn(
      directoryScansService,
      "complete"
    ).mockResolvedValue({
      ...runningRun,
      status: "completed",
      completed_at: "2026-01-01T00:00:01.000Z",
      error_count: 1,
      error_summaries: ["failed"],
    });

    try {
      const watcher = new WatcherService();
      const first = watcher.startScan(directory.id);
      await expect(watcher.startScan(directory.id)).rejects.toMatchObject({
        statusCode: 409,
        message: "Directory scan already in progress",
      });

      resolveDirectory(directory);
      const started = await first;
      expect(started.run).toEqual(runningRun);
      expect(createSpy).toHaveBeenCalledTimes(1);
      await expect(started.completion).rejects.toBeDefined();
      expect(completeSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      createSpy.mockRestore();
      completeSpy.mockRestore();
    }
  });
});
