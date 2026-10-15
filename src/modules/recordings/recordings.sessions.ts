/**
 * Live sessions: every minute the autopilot hands over GoondVR's channel list, and each online
 * channel's live gets a viewer reading and its title changes. When a live ends, a highlights
 * channel's recordings are cut to the moments the trained model is sure enough about, joined
 * into one video, and the raw files deleted. Policy lives in recordings.sessions.policy.ts.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recorderLiveSessionsTable, recordingReviewsTable, type LiveSessionClip } from "@/database/schema";
import { editsService } from "@/modules/edits/edits.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { videosService } from "@/modules/videos/videos.service";
import { visualSearchStore } from "@/modules/visual-search/visual-search.service";
import { ConflictError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { goondvr, type GoondvrChannel } from "./recordings.goondvr";
import { probeRecordingDuration } from "./recordings.duration";
import { detectWithProbe } from "./recordings.highlights";
import { loadHighlightProbe, probeThreshold } from "./recordings.probe";
import { recordingScope } from "./recordings.scope";
import {
  endedStatus,
  fileInSession,
  isContinuousAction,
  isStubRecording,
  keptSeconds,
  LIVE_HIGHLIGHT_STATES,
  liveClipOptions,
  liveEnded,
  orphanLives,
  recordedAtFromFileName,
  sampleSession,
  sessionTimeline,
  titleTags,
  type CaptureMode,
} from "./recordings.sessions.policy";

type SessionRow = typeof recorderLiveSessionsTable.$inferSelect;

/** Files not in the library this long after the live ended are given up on. */
const LIBRARY_WAIT_MS = 2 * 60 * 60_000;
/** Recordings not analysed this long after the live ended fail the session. */
const ANALYSIS_WAIT_MS = 12 * 60 * 60_000;
/** The recordings folder is not auto-scanned, so a live waiting on files imports them at most this often. */
const IMPORT_EVERY_MS = 5 * 60_000;

export interface ChannelCapture {
  capture: CaptureMode;
  threshold: number | null;
}

interface SessionRecording {
  id: number;
  fileName: string;
  filePath: string;
  durationSeconds: number | null;
}

class LiveSessions {
  private lastImportAt = 0;

  /** Follows every channel's live; `captureOf` says what Kura does with each channel. */
  async track(channels: GoondvrChannel[], captureOf: (channelId: string) => ChannelCapture, now: Date): Promise<void> {
    const open = new Map((await db.select().from(recorderLiveSessionsTable).where(isNull(recorderLiveSessionsTable.endedAt))).map((row) => [row.channelId, row]));
    for (const channel of channels) {
      const session = open.get(channel.id);
      open.delete(channel.id);
      const { capture, threshold } = captureOf(channel.id);
      if (channel.is_online) {
        if (!session) {
          await db
            .insert(recorderLiveSessionsTable)
            .values({
              channelId: channel.id,
              username: channel.username,
              site: channel.site,
              startedAt: now,
              capture,
              threshold,
              gender: channel.gender || null,
              ...sampleSession({ startedAt: now, titles: [], viewers: [], peakViewers: 0 }, { viewers: channel.viewer_count, title: channel.room_title ?? "", now }),
            })
            .onConflictDoNothing();
          continue;
        }
        await db
          .update(recorderLiveSessionsTable)
          .set({
            ...sampleSession(session, { viewers: channel.viewer_count, title: channel.room_title ?? "", now }),
            capture,
            threshold,
            gender: channel.gender || session.gender,
            updatedAt: now,
          })
          .where(eq(recorderLiveSessionsTable.id, session.id));
      } else if (session && liveEnded(session.lastSeenAt, false, now)) {
        await this.end(session, capture, threshold, now);
      }
    }
    // Channels removed from GoondVR end their live where it was last seen.
    for (const session of open.values()) {
      if (liveEnded(session.lastSeenAt, false, now)) await this.end(session, session.capture as CaptureMode, session.threshold, now);
    }
    for (const channel of channels) {
      const { capture, threshold } = captureOf(channel.id);
      if (capture !== "highlights") continue;
      await this.adoptOrphans(channel, threshold, now).catch((error) => logger.warn({ err: error, channel: channel.id }, "Could not adopt orphan recordings"));
    }
  }

  /**
   * GoondVR records on while Kura is down, and those files belong to no live, so they would sit in
   * review forever. They become an ended live of their own (one per run of files) and get cut like
   * any other. Only files since the channel's first followed live, and none someone has reviewed.
   */
  private async adoptOrphans(channel: GoondvrChannel, threshold: number | null, now: Date) {
    const sessions = await db.select().from(recorderLiveSessionsTable).where(eq(recorderLiveSessionsTable.channelId, channel.id));
    if (!sessions.length) return;
    const since = Math.min(...sessions.map((session) => session.startedAt.getTime()));
    const files = (await this.files(channel.username)).filter((file) => {
      const at = recordedAtFromFileName(file.fileName);
      return at && at.getTime() >= since && !sessions.some((session) => fileInSession(file.fileName, session));
    });
    if (!files.length) return;
    const reviews = await db
      .select({ videoId: recordingReviewsTable.videoId, status: recordingReviewsTable.status })
      .from(recordingReviewsTable)
      .where(inArray(recordingReviewsTable.videoId, files.map((file) => file.id)));
    const decided = new Set(reviews.filter((review) => !["proposed", "dismissed", "automatic"].includes(review.status)).map((review) => review.videoId));
    const orphans = files.filter((file) => !decided.has(file.id));
    for (const live of orphanLives(orphans.map((file) => ({ recordedAt: recordedAtFromFileName(file.fileName)!, durationSeconds: file.durationSeconds })))) {
      await db.insert(recorderLiveSessionsTable).values({
        channelId: channel.id,
        username: channel.username,
        site: channel.site,
        startedAt: live.startedAt,
        lastSeenAt: live.lastStartAt,
        endedAt: live.lastStartAt,
        capture: "highlights",
        threshold,
        status: "waiting",
        gender: channel.gender || null,
        updatedAt: now,
      });
      logger.info({ channel: channel.username, from: live.startedAt.toISOString(), to: live.lastStartAt.toISOString() }, "Adopted recordings made while Kura was away");
    }
  }

  private async end(session: SessionRow, capture: CaptureMode, threshold: number | null, now: Date) {
    await db
      .update(recorderLiveSessionsTable)
      .set({ endedAt: session.lastSeenAt, capture, threshold, status: endedStatus(capture), updatedAt: now })
      .where(eq(recorderLiveSessionsTable.id, session.id));
  }

  /** Moves highlights lives along: waiting for their files, rendering, then cleaning up. */
  async advance(now: Date): Promise<void> {
    const rows = await db.select().from(recorderLiveSessionsTable).where(inArray(recorderLiveSessionsTable.status, ["waiting", "rendering"]));
    for (const session of rows) {
      try {
        if (session.status === "waiting") await this.cut(session, now);
        else await this.collect(session, now);
      } catch (error) {
        logger.warn({ err: error, session: session.id }, "Live session step failed");
        await this.patch(session.id, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.hideFromReview().catch((error) => logger.warn({ err: error }, "Could not take highlights recordings out of review"));
  }

  /** A channel's library recordings. */
  private async files(username: string): Promise<SessionRecording[]> {
    const scope = await recordingScope();
    if (!scope.directoryId) return [];
    const prefix = `${username.replace(/^@/, "").replace(/[\\%_]/g, "\\$&")}\\_%`;
    const rows = await db.execute<{ id: number; file_name: string; file_path: string; duration_seconds: number | null }>(sql`
      SELECT id, file_name, file_path, duration_seconds FROM videos
      WHERE directory_id = ${scope.directoryId} AND file_name ILIKE ${prefix}`);
    return rows.map((row) => ({ id: Number(row.id), fileName: String(row.file_name), filePath: String(row.file_path), durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds) }));
  }

  /** The library recordings a live made. */
  private async recordings(session: SessionRow): Promise<SessionRecording[]> {
    return (await this.files(session.username)).filter((recording) => fileInSession(recording.fileName, session));
  }

  /** Scans the recordings folder (nothing else does) so a finished live's files reach the library. */
  private async importRecordings() {
    if (Date.now() - this.lastImportAt < IMPORT_EVERY_MS) return;
    this.lastImportAt = Date.now();
    const scope = await recordingScope();
    if (!scope.directoryId) return;
    const { watcherService } = await import("@/modules/directories/watcher.service");
    try {
      const { completion } = await watcherService.startScan(scope.directoryId);
      void completion.catch((error) => logger.warn({ err: error }, "Recordings folder scan failed"));
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }

  /** Once every file of the live is analysed: find its moments and start the one render. */
  private async cut(session: SessionRow, now: Date) {
    const since = now.getTime() - (session.endedAt ?? session.lastSeenAt).getTime();
    const owned = (await goondvr.recordings()).filter((recording) => fileInSession(recording.name, session));
    if (owned.some((recording) => recording.active)) return;
    const recordings = await this.recordings(session);
    const inLibrary = new Set(recordings.map((recording) => recording.fileName));
    if (owned.some((recording) => !inLibrary.has(recording.name.split("/").at(-1) ?? recording.name))) {
      if (since < LIBRARY_WAIT_MS) return this.importRecordings();
      if (!recordings.length) {
        await this.patch(session.id, { status: "failed", error: "GoondVR's files never reached the library; they are kept" });
        return;
      }
    }
    if (!recordings.length) {
      if (since >= LIBRARY_WAIT_MS) await this.patch(session.id, { status: "empty", clips: [], error: null });
      return;
    }
    // Reconnect stubs never get analysed; they would hold the live back, and are deleted with the rest.
    const analysable = recordings.filter((recording) => !isStubRecording(recording.durationSeconds));
    if (!analysable.length) {
      await this.patch(session.id, { status: "empty", clips: [], error: null });
      await this.deleteRecordings(session, recordings);
      return;
    }
    const reviews = await db
      .select({ videoId: recordingReviewsTable.videoId })
      .from(recordingReviewsTable)
      .where(inArray(recordingReviewsTable.videoId, analysable.map((recording) => recording.id)));
    const analysed = new Set(reviews.map((review) => review.videoId));
    if (analysable.some((recording) => !analysed.has(recording.id))) {
      if (since >= ANALYSIS_WAIT_MS) await this.patch(session.id, { status: "failed", error: "Some recordings were never analysed; they are kept" });
      return;
    }

    const probe = await loadHighlightProbe();
    if (!probe) {
      await this.patch(session.id, { status: "failed", error: "Highlights need the trained detector, and none is exported" });
      return;
    }
    const { recordingsService } = await import("./recordings.service");
    const settings = await recordingsService.settings();
    const threshold = session.threshold ?? probeThreshold(settings.sensitivity);
    const store = visualSearchStore();
    const indexed = await store.indexed(analysable.map((recording) => recording.id));
    const found: { videoId: number; recordedAt: Date | null; durationSeconds: number; clips: LiveSessionClip[] }[] = [];
    for (const recording of analysable) {
      if (indexed.get(recording.id)?.modelRevision !== probe.modelRevision) {
        await this.patch(session.id, { status: "failed", error: `${recording.fileName} was indexed with another image model; it is kept` });
        return;
      }
      const frames = await store.videoFrames(recording.id);
      const duration = await probeRecordingDuration(recording.filePath, recording.durationSeconds ?? frames.timestamps.at(-1) ?? 0);
      const result = detectWithProbe({ ...frames, durationSeconds: duration, probe, states: LIVE_HIGHLIGHT_STATES, threshold, options: liveClipOptions(threshold) });
      found.push({
        videoId: recording.id,
        recordedAt: recordedAtFromFileName(recording.fileName),
        durationSeconds: duration,
        clips: result.clips.map((clip) => ({ video_id: recording.id, start_seconds: clip.start_seconds, end_seconds: clip.end_seconds, score: clip.score })),
      });
    }
    const clips = found.flatMap((recording) => recording.clips);
    const segments = sessionTimeline(found);
    if (!segments.length) {
      // Nothing reached the threshold: nothing of this live is stored.
      await this.patch(session.id, { status: "empty", clips: [], error: null });
      await this.deleteRecordings(session, recordings);
      return;
    }
    const liveSeconds = found.reduce((sum, recording) => sum + recording.durationSeconds, 0);
    if (isContinuousAction(keptSeconds(clips), liveSeconds)) {
      // Nothing is deleted: the recordings go back to the review queue to have their highlights chosen.
      await db
        .update(recordingReviewsTable)
        .set({ status: sql`CASE WHEN jsonb_array_length(${recordingReviewsTable.clips}) > 0 THEN 'proposed' ELSE 'dismissed' END` })
        .where(and(inArray(recordingReviewsTable.videoId, analysable.map((recording) => recording.id)), eq(recordingReviewsTable.status, "automatic")));
      await this.patch(session.id, { status: "review", clips, error: null });
      logger.info({ session: session.id, action: Math.round(keptSeconds(clips)), live: Math.round(liveSeconds) }, "Live is mostly action; sent to review");
      return;
    }
    if (!settings.clipsDirectoryId) {
      await this.patch(session.id, { status: "failed", error: "No library directory to render highlights into" });
      return;
    }
    const day = (session.startedAt.toISOString().slice(0, 16)).replace("T", "_").replace(":", "-");
    const job = await editsService.create(segments[0]!.source_video_id, {
      output: {
        directory_id: settings.clipsDirectoryId,
        file_name: `${session.username.replace(/[^\w.-]+/g, "_")}_${day}_highlights_${session.id}.mkv`,
        format: "mkv",
        video_codec: "av1",
        audio_codec: "opus",
      },
      timeline: { segments },
    });
    await this.patch(session.id, { status: "rendering", clips, jobId: job.id, error: null });
    logger.info({ session: session.id, segments: segments.length, seconds: Math.round(keptSeconds(clips)) }, "Rendering a live's highlights");
  }

  /** A finished render: link it to the channel's creator, then delete the raw files. */
  private async collect(session: SessionRow, now: Date) {
    if (!session.jobId) return this.patch(session.id, { status: "waiting" });
    const job = await editsService.getById(session.jobId).catch(() => null);
    if (!job || job.status === "failed" || job.status === "cancelled") {
      await this.patch(session.id, { status: "failed", error: job?.errorMessage ?? "The highlights render did not finish; the recordings are kept" });
      return;
    }
    if (job.status !== "completed" || !job.outputVideoId) return;
    const { recordingsService } = await import("./recordings.service");
    const creator = await recordingsService.creatorForUsername(session.username);
    if (creator) await videosBulkService.bulkUpdateCreators({ videoIds: [job.outputVideoId], creatorIds: [creator.id], action: "add" });
    await this.patch(session.id, { status: "done", outputVideoId: job.outputVideoId, error: null });
    await this.deleteRecordings(session, await this.recordings(session));
    logger.info({ session: session.id, output: job.outputVideoId, at: now.toISOString() }, "Live highlights finished");
  }

  private async deleteRecordings(session: SessionRow, recordings: SessionRecording[]) {
    if (env.DEMO_MODE) return;
    const { recordingsService } = await import("./recordings.service");
    const failed: string[] = [];
    for (const recording of recordings) {
      try {
        await recordingsService.deleteRecording(await videosService.findById(recording.id));
      } catch (error) {
        failed.push(`${recording.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length) await this.patch(session.id, { error: `Could not delete ${failed.length} raw file(s): ${failed[0]}` });
  }

  /**
   * Highlights recordings are cut without review: their analyses leave the review queue (and stop
   * holding the training autopilot back) as soon as they exist.
   */
  private async hideFromReview() {
    const rows = await db
      .select()
      .from(recorderLiveSessionsTable)
      .where(and(eq(recorderLiveSessionsTable.capture, "highlights"), inArray(recorderLiveSessionsTable.status, ["live", "waiting"])));
    for (const session of rows) {
      const ids = (await this.recordings(session)).map((recording) => recording.id);
      if (!ids.length) continue;
      await db
        .update(recordingReviewsTable)
        .set({ status: "automatic" })
        .where(and(inArray(recordingReviewsTable.videoId, ids), inArray(recordingReviewsTable.status, ["proposed", "dismissed"])));
    }
  }

  private async patch(id: number, values: Partial<SessionRow>) {
    await db.update(recorderLiveSessionsTable).set({ ...values, updatedAt: new Date() }).where(eq(recorderLiveSessionsTable.id, id));
  }

  async list(options: { channelId?: string; limit?: number } = {}) {
    if (env.DEMO_MODE) return [];
    const rows = await db
      .select()
      .from(recorderLiveSessionsTable)
      .where(options.channelId ? eq(recorderLiveSessionsTable.channelId, options.channelId) : undefined)
      .orderBy(desc(recorderLiveSessionsTable.startedAt))
      .limit(Math.min(200, options.limit ?? 30));
    return Promise.all(rows.map(async (row) => present(row, (await this.recordings(row)).map((recording) => recording.id))));
  }

  /** The live a recording was made in, if Kura followed it. */
  async forVideo(video: { id: number; file_name: string }) {
    if (env.DEMO_MODE) return null;
    const at = recordedAtFromFileName(video.file_name);
    const username = /^(.+?)_\d{4}-\d{2}-\d{2}_/.exec(video.file_name.split("/").at(-1) ?? "")?.[1];
    if (!at || !username) return null;
    const rows = await db
      .select()
      .from(recorderLiveSessionsTable)
      .where(sql`lower(${recorderLiveSessionsTable.username}) = ${username.replace(/^@/, "").toLowerCase()}
        AND ${recorderLiveSessionsTable.startedAt} <= ${new Date(at.getTime() + 6 * 60_000)}
        AND coalesce(${recorderLiveSessionsTable.endedAt}, ${recorderLiveSessionsTable.lastSeenAt}) >= ${new Date(at.getTime() - 60_000)}`)
      .orderBy(desc(recorderLiveSessionsTable.startedAt))
      .limit(3);
    const row = rows.find((candidate) => fileInSession(video.file_name, candidate)) ?? null;
    return row ? present(row, [video.id]) : null;
  }
}

function present(row: SessionRow, videoIds: number[]) {
  const counts = row.viewers.map(([, viewers]) => viewers);
  return {
    id: row.id,
    channel_id: row.channelId,
    username: row.username,
    site: row.site,
    started_at: row.startedAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    capture: row.capture,
    threshold: row.threshold,
    status: row.status,
    gender: row.gender,
    titles: row.titles,
    tags: titleTags(row.titles),
    viewers: row.viewers,
    peak_viewers: row.peakViewers,
    average_viewers: counts.length ? Math.round(counts.reduce((sum, value) => sum + value, 0) / counts.length) : null,
    kept_seconds: row.clips ? Math.round(keptSeconds(row.clips)) : null,
    clip_count: row.clips?.length ?? null,
    output_video_id: row.outputVideoId,
    video_ids: videoIds,
    error: row.error,
  };
}

export type LiveSessionView = ReturnType<typeof present>;

export const liveSessions = new LiveSessions();
