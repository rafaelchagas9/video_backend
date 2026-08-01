import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitStagedDemoArtwork } from "../scripts/demo-artwork-commit";

const root = mkdtempSync(join(tmpdir(), "demo-artwork-commit-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("demo artwork generation commit", () => {
  it("restores the snapshot when database replacement mutates and throws", async () => {
    const outputRoot = join(root, "artwork-database-failure");
    const stagingRoot = join(root, ".artwork-staging-database-failure");
    const backupRoot = join(root, ".artwork-backup-database-failure");
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(outputRoot, "old.txt"), "old artwork");
    writeFileSync(join(stagingRoot, "new.txt"), "new artwork");

    let databaseState = "old database";
    let baselineCalled = false;

    await expect(
      commitStagedDemoArtwork({
        outputRoot,
        stagingRoot,
        backupRoot,
        captureDatabaseSnapshot: () => databaseState,
        replaceDatabase: () => {
          databaseState = "partially replaced database";
          throw new Error("forced database failure");
        },
        restoreDatabaseSnapshot: (snapshot) => {
          databaseState = snapshot;
        },
        createBaselineSnapshot: () => {
          baselineCalled = true;
          return "unused";
        },
      })
    ).rejects.toThrow("forced database failure");

    expect(databaseState).toBe("old database");
    expect(baselineCalled).toBe(false);
    expect(readFileSync(join(outputRoot, "old.txt"), "utf8")).toBe(
      "old artwork"
    );
    expect(existsSync(join(outputRoot, "new.txt"))).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("restores assets and database state when baseline creation fails", async () => {
    const outputRoot = join(root, "artwork");
    const stagingRoot = join(root, ".artwork-staging-test");
    const backupRoot = join(root, ".artwork-backup-test");
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(outputRoot, "old.txt"), "old artwork");
    writeFileSync(join(stagingRoot, "new.txt"), "new artwork");

    let databaseState = "old database";
    const baselineState = "old baseline";

    await expect(
      commitStagedDemoArtwork({
        outputRoot,
        stagingRoot,
        backupRoot,
        captureDatabaseSnapshot: () => databaseState,
        replaceDatabase: () => {
          databaseState = "new database";
        },
        restoreDatabaseSnapshot: (snapshot) => {
          databaseState = snapshot;
        },
        createBaselineSnapshot: () => {
          throw new Error("forced baseline failure");
        },
      })
    ).rejects.toThrow("forced baseline failure");

    expect(databaseState).toBe("old database");
    expect(baselineState).toBe("old baseline");
    expect(readFileSync(join(outputRoot, "old.txt"), "utf8")).toBe(
      "old artwork"
    );
    expect(existsSync(join(outputRoot, "new.txt"))).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(existsSync(backupRoot)).toBe(false);
  });
});
