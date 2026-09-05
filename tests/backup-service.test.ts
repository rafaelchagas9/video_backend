import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const postgresSettings = {
  DEMO_MODE: false,
  POSTGRES_HOST: "localhost; not-a-shell-command",
  POSTGRES_PORT: 5432,
  POSTGRES_USER: "user with spaces",
  POSTGRES_DB: "database'quoted",
  POSTGRES_PASSWORD: "password'$(never-executed)",
};
mock.module("@/config/env", () => ({ env: postgresSettings }));
mock.module("@/config/drizzle", () => ({ db: {} }));
mock.module("@/modules/backup/backup.demo.service", () => ({
  backupDemoService: {},
}));
mock.module("@/utils/logger", () => ({ logger: { info() {}, error() {} } }));

let processFailure: Error | null = null;
const execFile = mock(
  (
    command: string,
    args: string[],
    _options: { env: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    if (command === "pg_dump") {
      writeFileSync(args[args.indexOf("-f") + 1], "-- backup fixture");
    }
    queueMicrotask(() => callback(processFailure, "", ""));
  }
);
mock.module("node:child_process", () => ({ execFile }));

const { BackupService } = await import("@/modules/backup/backup.service");
const root = mkdtempSync(join(tmpdir(), "conversor-backup-test-"));
const backupDirectory = join(root, "backups");
const service = new BackupService(backupDirectory);

beforeEach(() => {
  execFile.mockClear();
  processFailure = null;
  rmSync(backupDirectory, { recursive: true, force: true });
  mkdirSync(backupDirectory);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("creates backups without shell interpolation and isolates concurrent output files", async () => {
  const firstPending = service.createBackup();
  expect(service.listBackups()).toEqual([]);
  const [first, second] = await Promise.all([
    firstPending,
    service.createBackup(),
  ]);
  expect(first.path).not.toBe(second.path);
  expect(readFileSync(first.path, "utf8")).toBe("-- backup fixture");
  const [command, args, options] = execFile.mock.calls[0];
  expect(command).toBe("pg_dump");
  expect(args).toEqual(["-F", "p", "-f", `${first.path}.partial`]);
  expect(options.env).toMatchObject({
    PGHOST: postgresSettings.POSTGRES_HOST,
    PGPORT: "5432",
    PGUSER: postgresSettings.POSTGRES_USER,
    PGDATABASE: postgresSettings.POSTGRES_DB,
    PGPASSWORD: postgresSettings.POSTGRES_PASSWORD,
  });
  expect(service.listBackups()).toHaveLength(2);
});

test("passes an existing backup's shell characters literally and deletes that file only", async () => {
  const filename = "backup 'quoted' $(not-executed);.sql";
  const filePath = join(backupDirectory, filename);
  writeFileSync(filePath, "-- fixture");
  await service.restoreBackup(filename);
  expect(execFile.mock.calls[0][0]).toBe("psql");
  expect(execFile.mock.calls[0][1]).toEqual([
    "--no-psqlrc",
    "--quiet",
    "--set=ON_ERROR_STOP=1",
    "-f",
    filePath,
  ]);
  service.deleteBackup(filename);
  expect(service.listBackups()).toEqual([]);
});

test("rejects traversal, directories, and symlinks before restore or deletion", async () => {
  const outsidePath = join(root, "outside.sql");
  writeFileSync(outsidePath, "-- untouched");
  symlinkSync(outsidePath, join(backupDirectory, "linked.sql"));
  mkdirSync(join(backupDirectory, "directory.sql"));

  for (const filename of [
    "../outside.sql",
    outsidePath,
    "..\\outside.sql",
    ".",
    "..",
    "",
    "bad\0.sql",
    "linked.sql",
    "directory.sql",
  ]) {
    await expect(service.restoreBackup(filename)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(() => service.deleteBackup(filename)).toThrow();
  }
  expect(execFile).not.toHaveBeenCalled();
  expect(readFileSync(outsidePath, "utf8")).toBe("-- untouched");
  expect(service.listBackups()).toEqual([]);
});

test("preserves missing-backup and failed-command API errors", async () => {
  await expect(service.restoreBackup("missing.sql")).rejects.toMatchObject({
    statusCode: 404,
  });
  writeFileSync(join(backupDirectory, "valid.sql"), "-- fixture");
  processFailure = new Error("mock subprocess failed");
  await expect(service.restoreBackup("valid.sql")).rejects.toMatchObject({
    statusCode: 400,
    message:
      "Failed to restore database from backup. Ensure psql is available.",
  });
  await expect(service.createBackup()).rejects.toMatchObject({
    statusCode: 400,
    message: "Failed to create database backup. Ensure pg_dump is available.",
  });
  expect(readdirSync(backupDirectory)).toEqual(["valid.sql"]);
});
