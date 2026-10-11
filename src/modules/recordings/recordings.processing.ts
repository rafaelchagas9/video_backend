/**
 * Works through recordings that have no review yet, one at a time: frames, thumbnail, storyboard,
 * visual index, hover preview and highlight analysis. Faces are skipped on purpose; recordings
 * don't need them and they saturate the vision service. The pending list is read from the
 * database, so a server restart loses nothing, and the paused flag is persisted so a pause
 * survives one too.
 */
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { settingsService } from "@/modules/settings/settings.service";
import { logger } from "@/utils/logger";
import { recordingScope } from "./recordings.scope";
import { drainPendingRecordingAudioJobs } from "./recordings.audio-cache";

const PAUSED_KEY = "recordings_processing_paused";
const NAME_PATTERN = "_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}";

export interface RecordingsProcessingStatus {
  paused: boolean;
  running: boolean;
  pending: number;
  current: { videoId: number; fileName: string; startedAt: string } | null;
  processedThisSession: number;
  failedThisSession: number;
  lastError: string | null;
}

const pendingWhere = (directoryId: number) => sql`
  v.directory_id = ${directoryId}
  AND v.duration_seconds IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recording_reviews r WHERE r.video_id = v.id)
  AND v.file_name ~ ${NAME_PATTERN}`;

class RecordingsProcessing {
  private running = false;
  private stopRequested = false;
  private current: RecordingsProcessingStatus["current"] = null;
  private processed = 0;
  private failed = 0;
  private lastError: string | null = null;
  /** Videos already tried in this run. Cleared by resume/start, so failures get retried then. */
  private attempted = new Set<number>();

  async isPaused(): Promise<boolean> {
    return String(await settingsService.getValue(PAUSED_KEY)) === "true";
  }

  async status(): Promise<RecordingsProcessingStatus> {
    const [paused, scope] = await Promise.all([this.isPaused(), recordingScope()]);
    let pending = 0;
    if (scope.directoryId) {
      const [row] = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM videos v WHERE ${pendingWhere(scope.directoryId)}`
      );
      pending = Number(row?.count ?? 0);
    }
    return {
      paused,
      running: this.running,
      pending,
      current: this.current,
      processedThisSession: this.processed,
      failedThisSession: this.failed,
      lastError: this.lastError,
    };
  }

  /** Called on boot, when the watcher finds new recordings, and by resume/start. No-op while paused. */
  async kick(): Promise<void> {
    if (env.DEMO_MODE || this.running) return;
    this.running = true;
    try {
      if (await this.isPaused()) {
        this.running = false;
        return;
      }
    } catch (error) {
      this.running = false;
      throw error;
    }
    this.stopRequested = false;
    void this.loop().finally(() => {
      this.running = false;
      this.current = null;
    });
  }

  async pause(): Promise<RecordingsProcessingStatus> {
    await settingsService.updateValues({ [PAUSED_KEY]: "true" });
    this.stopRequested = true;
    return this.status();
  }

  /** Lifts a pause and retries anything that failed earlier in this server session. */
  async resume(): Promise<RecordingsProcessingStatus> {
    await settingsService.updateValues({ [PAUSED_KEY]: "false" });
    this.attempted.clear();
    if (!env.DEMO_MODE) {
      // Explicit Resume/Start also retries existing analysed generations once, with a finite worker budget.
      await drainPendingRecordingAudioJobs().catch((error) => logger.warn({ error }, "Could not resume pending recording audio features"));
    }
    await this.kick();
    return this.status();
  }

  stop() {
    this.stopRequested = true;
  }

  private async next(directoryId: number) {
    const tried = [...this.attempted];
    const [row] = await db.execute<{ id: number; file_name: string }>(sql`
      SELECT v.id, v.file_name FROM videos v
      WHERE ${pendingWhere(directoryId)}
        ${tried.length ? sql`AND v.id <> ALL(${`{${tried.join(",")}}`}::int[])` : sql``}
      ORDER BY v.id ASC LIMIT 1`);
    return row ? { id: Number(row.id), fileName: String(row.file_name) } : null;
  }

  private async loop() {
    const { directoryId } = await recordingScope();
    if (!directoryId) return;
    logger.info("Recordings processing started");
    try {
      while (!this.stopRequested && !(await this.isPaused())) {
        const next = await this.next(directoryId);
        if (!next) break;
        // One attempt per run, so a video that keeps failing can't be picked again forever.
        this.attempted.add(next.id);
        this.current = { videoId: next.id, fileName: next.fileName, startedAt: new Date().toISOString() };
        const started = Date.now();
        try {
          await this.processOne(next.id);
          this.processed += 1;
          this.lastError = null;
          logger.info({ videoId: next.id, ms: Date.now() - started }, "Recording processed");
        } catch (error) {
          this.failed += 1;
          this.lastError = `${next.fileName}: ${error instanceof Error ? error.message : String(error)}`;
          logger.warn({ err: error, videoId: next.id }, "Recording processing failed");
        }
      }
    } finally {
      logger.info({ processed: this.processed, failed: this.failed }, "Recordings processing stopped");
    }
  }

  private async processOne(videoId: number) {
    const [{ videosService }, { getFaceRecognitionService }, { previewsService }, { recordingsService }] = await Promise.all([
      import("@/modules/videos/videos.service"),
      import("@/modules/face-recognition/face-recognition.service"),
      import("@/modules/previews/previews.service"),
      import("./recordings.service"),
    ]);
    const video = await videosService.findById(videoId);
    if (!video.duration_seconds) throw new Error("duration not available");
    // Frames of a file GoondVR is still writing stop where the write had got to.
    await recordingsService.assertFinished(video);
    const [row] = await db.execute<{ has: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM storyboards WHERE video_id = ${videoId}) AS has`
    );
    // visualIndex: false keeps the storyboard step from starting a second, parallel index and
    // analysis of the same video; analyze() below indexes it itself.
    if (!row?.has)
      await getFaceRecognitionService().processVideo(videoId, video.file_path, video.duration_seconds, {
        faces: false,
        visualIndex: false,
      });
    await previewsService.queueGenerate(videoId);
    await recordingsService.analyze(1, videoId, { automatic: true });
  }
}

export const recordingsProcessing = new RecordingsProcessing();
