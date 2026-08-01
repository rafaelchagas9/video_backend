import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";

const databasePath = `/tmp/conversor-video-demo-operations-${process.pid}.sqlite`;

let closeDemoDatabase: () => void;
let sqlite: import("bun:sqlite").Database;
let ConversionOperationsDemoService: typeof import("@/modules/conversion/conversion.operations.demo.service").ConversionOperationsDemoService;
let StatsDemoService: typeof import("@/modules/stats/stats.demo.service").StatsDemoService;
let SettingsDemoService: typeof import("@/modules/settings/settings.demo.service").SettingsDemoService;
let EnrichmentDemoService: typeof import("@/modules/enrichment/enrichment.demo.service").EnrichmentDemoService;
let EditsDemoService: typeof import("@/modules/edits/edits.demo.service").EditsDemoService;
let BackupDemoService: typeof import("@/modules/backup/backup.demo.service").BackupDemoService;
let originalConfig: {
  demoMode: boolean;
};

beforeAll(async () => {
  const { env } = await import("@/config/env");
  originalConfig = {
    demoMode: env.DEMO_MODE,
  };
  env.DEMO_MODE = true;

  const demoDatabase = await import("@/database/demo");
  demoDatabase.setDemoDatabasePathForTests(databasePath);

  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });

  demoDatabase.initializeDemoDatabase();
  sqlite = demoDatabase.getDemoSqlite();
  closeDemoDatabase = demoDatabase.closeDemoDatabase;

  sqlite.run(
    `INSERT INTO demo_videos (
      id, source_video_id, file_path, file_name, directory_id,
      file_size_bytes, duration_seconds, width, height, codec, bitrate, fps,
      audio_codec, title, description, themes, is_available, indexed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      null,
      "/demo-assets/videos/sample.mp4",
      "sample.mp4",
      7,
      1_000_000,
      100,
      1920,
      1080,
      "h264",
      8_000_000,
      30,
      "aac",
      "Demo Sample",
      null,
      null,
      1,
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
    ]
  );
  sqlite.run(
    `INSERT INTO demo_creators (
      id, name, description, profile_picture_path, main_picture_path,
      face_thumbnail_path, extra_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      "Demo Creator",
      "Original biography",
      null,
      null,
      null,
      null,
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
    ]
  );
  sqlite.run(
    `INSERT INTO demo_enrichment_suggestions (
      id, entity_type, entity_id, type, field_key, value, source,
      source_url, confidence, face_match_score, cached_preview_path,
      status, dedup_hash, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      "creator",
      1,
      "bio",
      null,
      "Demo biography suggestion",
      "theporndb",
      null,
      0.9,
      null,
      null,
      "pending",
      "demo-creator-1-bio",
      null,
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
    ]
  );
  sqlite.run(
    `INSERT INTO demo_video_stats (
      user_id, video_id, play_count, total_watch_seconds,
      session_watch_seconds, session_play_counted, last_position_seconds,
      last_played_at, last_watch_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      1,
      3,
      75,
      25,
      1,
      25,
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
    ]
  );

  ({ ConversionOperationsDemoService } =
    await import("@/modules/conversion/conversion.operations.demo.service"));
  ({ StatsDemoService } = await import("@/modules/stats/stats.demo.service"));
  ({ SettingsDemoService } =
    await import("@/modules/settings/settings.demo.service"));
  ({ EnrichmentDemoService } =
    await import("@/modules/enrichment/enrichment.demo.service"));
  ({ EditsDemoService } = await import("@/modules/edits/edits.demo.service"));
  ({ BackupDemoService } =
    await import("@/modules/backup/backup.demo.service"));
});

afterAll(async () => {
  closeDemoDatabase?.();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });

  const { env } = await import("@/config/env");
  env.DEMO_MODE = originalConfig.demoMode;
  const { setDemoDatabasePathForTests } = await import("@/database/demo");
  setDemoDatabasePathForTests(null);
});

describe("SQLite demo operations services", () => {
  it("persists the conversion lifecycle without running an external queue", async () => {
    const service = new ConversionOperationsDemoService();
    const created = await service.createJob({
      video_id: 1,
      preset: "720p_av1",
      deleteOriginal: true,
    });

    expect(created).toMatchObject({
      id: 1,
      video_id: 1,
      status: "pending",
      progress_percent: 0,
      delete_original: true,
      target_resolution: "1280x-2",
    });
    expect(created.output_path).toStartWith("/demo-generated/");
    expect(await new ConversionOperationsDemoService().findById(1)).toEqual(
      created
    );
    expect(await service.getQueueStatus()).toEqual({
      queueLength: 1,
      activeJobs: 0,
      isProcessing: false,
    });

    const cancelled = await service.cancel(1);
    expect(cancelled.status).toBe("cancelled");
    expect(await service.getQueue()).toEqual([]);
    await service.delete(1);
    expect(await service.listByVideoId(1)).toEqual([]);

    const bulk = await service.bulkCreateJobs({
      videoIds: [1],
      preset: "1080p_av1",
      deleteOriginal: true,
      batchId: "demo-parity",
    });
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({
      video_id: 1,
      target_resolution: "original",
      delete_original: true,
      batch_id: "demo-parity",
    });
  });

  it("persists aggregate snapshots used by canonical and legacy stats routes", async () => {
    const service = new StatsDemoService();
    const library = await service.getCurrentLibraryStats();
    const usage = await service.getCurrentUsageStats();

    expect(library).toMatchObject({
      total_video_count: 1,
      available_video_count: 1,
      total_size_bytes: 1_000_000,
      total_duration_seconds: 100,
    });
    expect(library.resolution_breakdown[0]).toMatchObject({
      resolution: "1080p",
      count: 1,
      percentage: 100,
    });
    expect(usage).toMatchObject({
      total_watch_time_seconds: 75,
      total_play_count: 3,
      unique_videos_watched: 1,
      videos_never_watched: 0,
    });

    const snapshots = await service.createAllSnapshots();
    expect(snapshots.storage.id).toBe(1);
    expect(snapshots.library.id).toBe(1);
    expect(snapshots.content.id).toBe(1);
    expect(snapshots.usage.id).toBe(1);

    const freshService = new StatsDemoService();
    expect(await freshService.getLibraryHistory(30, 100)).toEqual([
      snapshots.library,
    ]);
    expect(await freshService.getUsageHistory(30, 100)).toEqual([
      snapshots.usage,
    ]);
  });

  it("persists settings values in SQLite across service instances", async () => {
    const service = new SettingsDemoService();
    await service.updateValues({
      max_suggestions: 25,
      notifications_in_app_enabled: false,
    });

    const freshService = new SettingsDemoService();
    expect(await freshService.getNumber("max_suggestions")).toBe(25);
    expect(await freshService.getValue("notifications_in_app_enabled")).toBe(
      false
    );
    expect(
      (await freshService.getAll()).find(
        (setting) => setting.key === "max_suggestions"
      )
    ).toEqual({
      key: "max_suggestions",
      value: 25,
      updated_at: "2026-01-01T12:00:00.000Z",
    });
  });

  it("runs and decides enrichment entirely against seeded SQLite data", async () => {
    const service = new EnrichmentDemoService();
    const run = await service.runEnrichment("creator", 1, {
      sources: ["theporndb"],
    });

    expect(run).toMatchObject({
      entity_type: "creator",
      entity_id: 1,
      status: "success",
      sources_used: ["theporndb"],
      suggestion_count: 1,
    });
    expect(
      await new EnrichmentDemoService().listRuns("creator", 1)
    ).toHaveLength(1);

    const accepted = await service.acceptSuggestion(1);
    expect(accepted.status).toBe("accepted");
    expect(
      await service.listSuggestions({
        entity_type: "creator",
        entity_id: 1,
        status: "accepted",
      })
    ).toHaveLength(1);
    expect(
      sqlite
        .query<
          { description: string },
          []
        >("SELECT description FROM demo_creators WHERE id = 1")
        .get()?.description
    ).toBe("Demo biography suggestion");
  });

  it("persists edit jobs without invoking render infrastructure", async () => {
    const service = new EditsDemoService();
    const metadata = await service.editingMetadata(1);
    expect(metadata).toMatchObject({ id: 1, title: "Demo Sample" });

    const job = await service.create(1, {
      output: {
        directory_id: 1,
        file_name: "demo-edit.mkv",
        format: "mkv",
        video_codec: "av1",
        audio_codec: "copy",
      },
      timeline: { segments: [{ start: 0, end: 10 }] },
    });
    expect(job.status).toBe("queued");
    expect(await new EditsDemoService().getById(job.id)).toEqual(job);
    expect((await service.cancel(job.id)).status).toBe("cancelled");
  });

  it("backs up, exports, and restores only the demo SQLite catalog", async () => {
    const service = new BackupDemoService();
    const originalTitle = sqlite
      .query<
        { title: string },
        []
      >("SELECT title FROM demo_videos WHERE id = 1")
      .get()!.title;
    const backup = await service.createBackup();

    expect(backup.path).toBe(`demo://backups/${backup.filename}`);
    expect(backup.filename).toMatch(/^demo-backup-\d{6}\.json$/);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(new BackupDemoService().listBackups()).toEqual([backup]);

    sqlite.run("UPDATE demo_videos SET title = ? WHERE id = 1", [
      "Mutated after backup",
    ]);
    sqlite.run("DELETE FROM demo_settings WHERE key = ?", ["max_suggestions"]);
    await service.restoreBackup(backup.filename);

    expect(
      sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title
    ).toBe(originalTitle);
    expect(
      sqlite
        .query<
          { value_json: string },
          [string]
        >("SELECT value_json FROM demo_settings WHERE key = ?")
        .get("max_suggestions")?.value_json
    ).toBe("25");
    expect(service.listBackups()).toEqual([backup]);

    const exported = await service.exportToJson();
    expect(exported.version).toBe("0.1.0-demo-sqlite");
    expect(exported.tables.videos).toHaveLength(1);
    expect(exported.tables.creators).toHaveLength(1);

    service.deleteBackup(backup.filename);
    expect(service.listBackups()).toEqual([]);
  });
});
