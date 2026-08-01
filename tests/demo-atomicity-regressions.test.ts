import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-atomicity-test";
process.env.POSTGRES_PASSWORD ||= "demo-atomicity-test";
process.env.SESSION_SECRET ||=
  "demo-atomicity-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-atomicity-${process.pid}.sqlite`;

describe("demo SQLite atomic operations", () => {
  let sqlite: import("bun:sqlite").Database;
  let originalDemoMode: boolean;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;

    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    demo.importDemoJsonFile(undefined, { reset: true });
    sqlite = demo.getDemoSqlite();
  });

  afterAll(async () => {
    const demo = await import("@/database/demo");
    demo.closeDemoDatabase();
    demo.setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  it("rolls back every conditional relationship family when a later family fails", async () => {
    sqlite.run(
      "DELETE FROM demo_video_creators WHERE video_id=1 AND creator_id=1"
    );
    sqlite.run("DELETE FROM demo_video_tags WHERE video_id=1 AND tag_id=1");
    sqlite.run(
      "DELETE FROM demo_video_studios WHERE video_id=1 AND studio_id=1"
    );
    sqlite.exec(`CREATE TRIGGER demo_test_fail_tag
      BEFORE INSERT ON demo_video_tags
      WHEN NEW.video_id=1 AND NEW.tag_id=1
      BEGIN SELECT RAISE(ABORT, 'forced tag failure'); END`);

    try {
      const { videosBulkService } =
        await import("@/modules/videos/videos.bulk.service");
      await expect(
        videosBulkService.bulkConditionalApply(
          1,
          { ids: [1] },
          {
            addCreatorIds: [1],
            addTagIds: [1],
            addStudioIds: [1],
          }
        )
      ).rejects.toThrow("forced tag failure");
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS demo_test_fail_tag");
    }

    expect(
      sqlite
        .query<{ count: number }, []>(
          `SELECT
             (SELECT count(*) FROM demo_video_creators WHERE video_id=1 AND creator_id=1) +
             (SELECT count(*) FROM demo_video_tags WHERE video_id=1 AND tag_id=1) +
             (SELECT count(*) FROM demo_video_studios WHERE video_id=1 AND studio_id=1)
           AS count`
        )
        .get()!.count
    ).toBe(0);
  });

  it("rolls back creator imports and rejects duplicate identities in one batch", async () => {
    sqlite.exec(`CREATE TRIGGER demo_test_fail_creator
      BEFORE INSERT ON demo_creators
      WHEN NEW.name='Atomic Creator B'
      BEGIN SELECT RAISE(ABORT, 'forced creator failure'); END`);
    const { creatorsBulkDemoService } =
      await import("@/modules/creators/creators.bulk.demo.service");

    try {
      await expect(
        creatorsBulkDemoService.bulkImport(
          [{ name: "Atomic Creator A" }, { name: "Atomic Creator B" }],
          "merge",
          false
        )
      ).rejects.toThrow("forced creator failure");
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS demo_test_fail_creator");
    }
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM demo_creators WHERE name LIKE 'Atomic Creator %'")
        .get()!.count
    ).toBe(0);

    const duplicate = await creatorsBulkDemoService.bulkImport(
      [{ name: "Duplicate Creator" }, { name: " duplicate creator " }],
      "merge",
      false
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.summary.errors).toBe(1);
    expect(duplicate.items[1]!.validation_errors).toContain(
      'Duplicate creator name " duplicate creator " in batch'
    );
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM demo_creators WHERE lower(trim(name))='duplicate creator'")
        .get()!.count
    ).toBe(0);
  });

  it("rolls back studio imports and rejects duplicate identities in one batch", async () => {
    sqlite.exec(`CREATE TRIGGER demo_test_fail_studio
      BEFORE INSERT ON demo_studios
      WHEN NEW.name='Atomic Studio B'
      BEGIN SELECT RAISE(ABORT, 'forced studio failure'); END`);
    const { studiosBulkDemoService } =
      await import("@/modules/studios/studios.bulk.demo.service");

    try {
      await expect(
        studiosBulkDemoService.bulkImport(
          [{ name: "Atomic Studio A" }, { name: "Atomic Studio B" }],
          "merge",
          false
        )
      ).rejects.toThrow("forced studio failure");
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS demo_test_fail_studio");
    }
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM demo_studios WHERE name LIKE 'Atomic Studio %'")
        .get()!.count
    ).toBe(0);

    const duplicate = await studiosBulkDemoService.bulkImport(
      [{ name: "Duplicate Studio" }, { name: "DUPLICATE STUDIO" }],
      "merge",
      false
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.summary.errors).toBe(1);
    expect(duplicate.items[1]!.validation_errors).toContain(
      'Duplicate studio name "DUPLICATE STUDIO" in batch'
    );
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM demo_studios WHERE lower(trim(name))='duplicate studio'")
        .get()!.count
    ).toBe(0);
  });

  it("never reuses backup filenames after deletion", async () => {
    const { backupDemoService } =
      await import("@/modules/backup/backup.demo.service");
    const first = await backupDemoService.createBackup();
    const second = await backupDemoService.createBackup();
    backupDemoService.deleteBackup(second.filename);
    const third = await backupDemoService.createBackup();
    backupDemoService.deleteBackup(first.filename);
    backupDemoService.deleteBackup(third.filename);
    const fourth = await backupDemoService.createBackup();

    expect(first.filename).toBe("demo-backup-000001.json");
    expect(second.filename).toBe("demo-backup-000002.json");
    expect(third.filename).toBe("demo-backup-000003.json");
    expect(fourth.filename).toBe("demo-backup-000004.json");
  });

  it("rolls back a backup restore whose snapshot violates foreign keys", async () => {
    const { backupDemoService } =
      await import("@/modules/backup/backup.demo.service");
    const backup = await backupDemoService.createBackup();
    try {
      const row = sqlite
        .query<
          { payload_json: string },
          [string, string]
        >("SELECT payload_json FROM demo_resources WHERE kind = ? AND id = ?")
        .get("demo-backup", backup.filename)!;
      const stored = JSON.parse(row.payload_json) as {
        snapshot: {
          tables: Record<string, Array<Record<string, unknown>>>;
        };
      };
      stored.snapshot.tables.demo_favorites ??= [];
      stored.snapshot.tables.demo_favorites.push({
        user_id: 1,
        video_id: 999_999,
        added_at: "2026-08-01T00:00:00.000Z",
      });
      sqlite.run(
        "UPDATE demo_resources SET payload_json = ? WHERE kind = ? AND id = ?",
        [JSON.stringify(stored), "demo-backup", backup.filename]
      );
      sqlite.run("UPDATE demo_videos SET title = ? WHERE id = 1", [
        "Live state must survive a rejected restore",
      ]);

      await expect(
        backupDemoService.restoreBackup(backup.filename)
      ).rejects.toThrow("violated SQLite foreign keys");

      expect(
        sqlite
          .query<
            { title: string },
            []
          >("SELECT title FROM demo_videos WHERE id = 1")
          .get()?.title
      ).toBe("Live state must survive a rejected restore");
      expect(
        sqlite
          .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
          .get()
      ).toBeNull();
      expect(
        sqlite.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
          ?.foreign_keys
      ).toBe(1);
    } finally {
      backupDemoService.deleteBackup(backup.filename);
    }
  });
});
