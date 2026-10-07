import { basename } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recordingReviewsTable, type RecordingClip } from "@/database/schema";
import { editsService } from "@/modules/edits/edits.service";
import { settingsService } from "@/modules/settings/settings.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { videosSearchService } from "@/modules/videos/videos.search.service";
import { videosService } from "@/modules/videos/videos.service";
import type { Video } from "@/modules/videos/videos.types";
import { indexVideoVisually } from "@/modules/visual-search/visual-search.jobs";
import { visualSearchService, visualSearchStore } from "@/modules/visual-search/visual-search.service";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { goondvr, usernameFromFileName } from "./recordings.goondvr";
import { recorderService } from "./recordings.live";
import { detectHighlights, detectWithProbe, isLikelySkip, joinStretches } from "./recordings.highlights";
import { loadHighlightProbe, PROBE_STATES, probeThreshold, type HighlightProbe, type ProbeState } from "./recordings.probe";
import { capRecordingClips, probeRecordingDuration } from "./recordings.duration";
import { DEMO_RECORDING_MIN_SECONDS, recordingScope } from "./recordings.scope";
import { feedbackSummary, markRecordingDiscarded, recordFeedback } from "./recordings.feedback";

export interface RecordingSettings {
  directoryId: number | null;
  clipsDirectoryId: number | null;
  highlightPrompts: string[];
  idlePrompts: string[];
  sensitivity: number;
  /** Which scorer finds highlights; "trained" falls back to prompts when no probe is exported. */
  detector: RecordingDetector;
  /** Probe states clipped by the trained detector. */
  highlightStates: ProbeState[];
  /** The exported probe, when there is one. */
  trainedModel: TrainedModelInfo | null;
}

export type RecordingDetector = "trained" | "prompts";

export interface TrainedModelInfo {
  version: string;
  labelledFrames: number;
  labelledRecordings: number;
  metrics: HighlightProbe["metrics"];
}

interface ReviewRow {
  videoId: number;
  status: string;
  clips: RecordingClip[];
  curve: number[];
  promptsRevision: string;
  deleteOriginal: boolean;
  error: string | null;
  analyzedAt: Date;
}

/* Demo reviews live in memory: the demo database resets on every start anyway. */
const demoReviews = new Map<number, ReviewRow>();

const lines = (value: unknown) =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** What produced a review's clips; a review whose revision differs predates a settings change. */
function revisionOf(settings: RecordingSettings, detector: RecordingDetector): string {
  return detector === "trained"
    ? JSON.stringify({ detector, model: settings.trainedModel?.version, states: settings.highlightStates, sensitivity: settings.sensitivity })
    : JSON.stringify([settings.highlightPrompts, settings.idlePrompts, settings.sensitivity]);
}

/** Older reviews stored a bare prompts array as their revision. */
function detectorOf(revision: string | undefined): RecordingDetector | null {
  if (!revision) return null;
  try {
    const parsed = JSON.parse(revision) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { detector?: unknown }).detector === "trained" ? "trained" : "prompts";
  } catch {
    return null;
  }
}

const isState = (value: string): value is ProbeState => (PROBE_STATES as readonly string[]).includes(value);

export class RecordingsService {
  async settings(): Promise<RecordingSettings> {
    const [scope, highlights, idle, sensitivity, detector, states, probe] = await Promise.all([
      recordingScope(),
      settingsService.getValue("recordings_highlight_prompts"),
      settingsService.getValue("recordings_idle_prompts"),
      settingsService.getNumber("recordings_sensitivity"),
      settingsService.getValue("recordings_detector"),
      settingsService.getValue("recordings_highlight_states"),
      loadHighlightProbe(),
    ]);
    const highlightStates = String(states ?? "").split(",").map((state) => state.trim()).filter(isState);
    return {
      directoryId: scope.directoryId,
      clipsDirectoryId: scope.clipsDirectoryId,
      highlightPrompts: lines(highlights),
      idlePrompts: lines(idle),
      sensitivity: sensitivity || 1.4,
      detector: detector === "prompts" ? "prompts" : "trained",
      highlightStates: highlightStates.length ? highlightStates : ["nude", "explicit"],
      trainedModel: probe
        ? { version: probe.version, labelledFrames: probe.labelledFrames, labelledRecordings: probe.labelledRecordings, metrics: probe.metrics }
        : null,
    };
  }

  async updateSettings(input: {
    highlightPrompts?: string[];
    idlePrompts?: string[];
    sensitivity?: number;
    directoryId?: number;
    detector?: RecordingDetector;
    highlightStates?: ProbeState[];
  }) {
    const values: Record<string, string | number> = {};
    if (input.detector) values.recordings_detector = input.detector;
    if (input.highlightStates?.length) values.recordings_highlight_states = input.highlightStates.join(",");
    if (input.highlightPrompts) values.recordings_highlight_prompts = input.highlightPrompts.join("\n");
    if (input.idlePrompts) values.recordings_idle_prompts = input.idlePrompts.join("\n");
    if (input.sensitivity !== undefined) values.recordings_sensitivity = input.sensitivity;
    if (input.directoryId !== undefined) values.recordings_directory_id = input.directoryId;
    await settingsService.updateValues(values);
    return this.settings();
  }

  private async row(videoId: number): Promise<ReviewRow | null> {
    if (env.DEMO_MODE) return demoReviews.get(videoId) ?? null;
    const [row] = await db.select().from(recordingReviewsTable).where(eq(recordingReviewsTable.videoId, videoId));
    return row ?? null;
  }

  private async save(row: ReviewRow): Promise<void> {
    if (env.DEMO_MODE) {
      demoReviews.set(row.videoId, row);
      return;
    }
    const values = { ...row, updatedAt: new Date() };
    await db
      .insert(recordingReviewsTable)
      .values(values)
      .onConflictDoUpdate({ target: recordingReviewsTable.videoId, set: values });
  }

  private async rows(videoIds: number[]): Promise<Map<number, ReviewRow>> {
    if (env.DEMO_MODE) return new Map(videoIds.flatMap((id) => (demoReviews.has(id) ? [[id, demoReviews.get(id)!]] : [])));
    if (!videoIds.length) return new Map();
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT video_id, status, clips FROM recording_reviews WHERE video_id = ANY(${`{${videoIds.join(",")}}`}::int[])`);
    return new Map(
      rows.map((row) => [
        Number(row.video_id),
        { videoId: Number(row.video_id), status: String(row.status), clips: row.clips as RecordingClip[] } as ReviewRow,
      ])
    );
  }

  /** A creator whose profile links to this channel, or who is named like it. */
  async creatorForUsername(username: string): Promise<{ id: number; name: string } | null> {
    if (env.DEMO_MODE) return null;
    const rows = await db.execute<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM creators c
      WHERE EXISTS (
        SELECT 1 FROM creator_social_links l WHERE l.creator_id = c.id
          AND lower(l.url) ~ ${`(chaturbate\\.com|stripchat\\.com|kick\\.com|twitch\\.tv|youtube\\.com)/@?${username.toLowerCase().replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`}
      ) OR lower(c.name) = ${username.toLowerCase()}
      ORDER BY c.id LIMIT 1`);
    return rows[0] ? { id: Number(rows[0].id), name: String(rows[0].name) } : null;
  }

  async overview(userId: number) {
    const settings = await this.settings();
    const channels = await goondvr.channels();
    const linked = channels ? await recorderService.withCreators(channels) : [];

    let videos: Video[] = [];
    if (settings.directoryId) {
      const page = await videosSearchService.list(userId, {
        directory_id: settings.directoryId,
        limit: 200,
        sort: "created_at",
        order: "desc",
        include: ["creators", "artwork"],
        ...(env.DEMO_MODE ? { minDuration: DEMO_RECORDING_MIN_SECONDS } : {}),
      });
      videos = page.data;
    }
    const reviews = await this.rows(videos.map((video) => video.id));
    return {
      goondvr: { reachable: channels !== null, channels: linked },
      directory_id: settings.directoryId,
      recordings: videos.map((video) => {
        const review = reviews.get(video.id);
        return {
          video,
          status: review?.status ?? "pending",
          clip_count: review?.clips.length ?? 0,
          kept_count: review?.clips.filter((clip) => clip.keep).length ?? 0,
        };
      }),
    };
  }

  async analyze(userId: number, videoId: number) {
    const video = await videosService.findById(videoId, userId);
    const settings = await this.settings();
    const store = visualSearchStore();
    let indexed = (await store.indexed([videoId])).get(videoId);
    if (!indexed) {
      if (env.DEMO_MODE) throw new BadRequestError("This demo video has no visual index");
      await indexVideoVisually(videoId, AbortSignal.timeout(30 * 60_000));
      indexed = (await store.indexed([videoId])).get(videoId);
    }
    // The probe only reads the embedding space it was trained in.
    const probe = settings.detector === "trained" ? await loadHighlightProbe() : null;
    const useProbe = probe !== null && indexed?.modelRevision === probe.modelRevision;
    if (!useProbe && !settings.highlightPrompts.length) throw new BadRequestError("Add at least one highlight description first");
    const frames = await store.videoFrames(videoId);
    const catalogDuration = video.duration_seconds ?? frames.timestamps.at(-1) ?? 0;
    const duration = env.DEMO_MODE ? catalogDuration : await probeRecordingDuration(video.file_path, catalogDuration);
    let result;
    if (useProbe) {
      result = detectWithProbe({
        ...frames,
        durationSeconds: duration,
        probe,
        states: settings.highlightStates,
        threshold: probeThreshold(settings.sensitivity),
      });
    } else {
      const [highlightVectors, idleVectors] = await Promise.all([
        Promise.all(settings.highlightPrompts.map((prompt) => visualSearchService.textVector(prompt))),
        Promise.all(settings.idlePrompts.map((prompt) => visualSearchService.textVector(prompt))),
      ]);
      result = detectHighlights({
        ...frames,
        durationSeconds: duration,
        highlights: settings.highlightPrompts.map((label, index) => ({ label, vector: highlightVectors[index]! })),
        idle: idleVectors,
        options: { sensitivity: settings.sensitivity },
      });
    }
    const row: ReviewRow = {
      videoId,
      status: result.clips.length ? "proposed" : "dismissed",
      clips: result.clips.map((clip, index) => ({
        ...clip,
        id: `c${index + 1}`,
        keep: !(useProbe && isLikelySkip(clip)),
        detected: { start_seconds: clip.start_seconds, end_seconds: clip.end_seconds },
      })),
      curve: result.curve,
      promptsRevision: revisionOf(settings, useProbe ? "trained" : "prompts"),
      deleteOriginal: false,
      error: null,
      analyzedAt: new Date(),
    };
    await this.save(row);
    await this.linkChannelCreator(video);
    return this.review(userId, videoId);
  }

  /** Recordings arrive without a creator; the channel name usually identifies one. */
  private async linkChannelCreator(video: Video) {
    if (video.creators?.length) return;
    const username = usernameFromFileName(video.file_name);
    const creator = username ? await this.creatorForUsername(username) : null;
    if (creator) await videosBulkService.bulkUpdateCreators({ videoIds: [video.id], creatorIds: [creator.id], action: "add" });
  }

  async review(userId: number, videoId: number) {
    let row = await this.row(videoId);
    if (row?.status === "rendering") row = (await this.finalize(videoId)) ?? row;
    const video = await videosService.findById(videoId, userId, ["creators"]).catch(() => null);
    if (!row) return { video, status: "pending", clips: [], curve: [], delete_original: false, error: null, analyzed_at: null, detector: null };
    return {
      video,
      detector: detectorOf(row.promptsRevision),
      status: row.status,
      clips: row.clips,
      curve: row.curve,
      delete_original: row.deleteOriginal,
      error: row.error,
      analyzed_at: row.analyzedAt.toISOString(),
    };
  }

  async updateClips(userId: number, videoId: number, clips: RecordingClip[]) {
    const row = await this.row(videoId);
    if (!row) throw new NotFoundError("This recording has not been analysed");
    if (row.status === "rendering") throw new BadRequestError("Clips are being rendered");
    const video = await videosService.findById(videoId, userId);
    const duration = video.duration_seconds ?? Infinity;
    for (const clip of clips)
      if (!(clip.end_seconds > clip.start_seconds) || clip.start_seconds < 0 || clip.end_seconds > duration + 1)
        throw new BadRequestError("Every clip must end after it starts, inside the recording");
    // Clips added by hand were never detected; a merge sends back the pair's combined proposal.
    const next = clips.map((clip) => {
      if (!clip.id.startsWith("added-")) return clip;
      const { detected: _detected, ...rest } = clip;
      return rest;
    });
    await this.save({ ...row, clips: next, status: next.some((clip) => clip.keep) ? "proposed" : "dismissed" });
    await this.recordDecisions(row, video, next);
    return this.review(userId, videoId);
  }

  /** Training data for what is worth keeping; a failure here never loses the review itself. */
  private async recordDecisions(row: ReviewRow, video: Video, clips: RecordingClip[], rendered = false) {
    try {
      await recordFeedback(
        { videoId: row.videoId, analyzedAt: row.analyzedAt, promptsRevision: row.promptsRevision, fileName: video.file_name, durationSeconds: video.duration_seconds ?? null },
        clips,
        { rendered }
      );
    } catch (error) {
      logger.warn({ error, videoId: row.videoId }, "Could not record review decisions");
    }
  }

  feedback() {
    return feedbackSummary();
  }

  /**
   * Renders the kept highlights: one clip video each, or (`combine`) a single video of every
   * kept stretch in recording order, overlaps joined. Combined, every kept clip points at the
   * same job and, once it finishes, the same output video.
   */
  async render(userId: number, videoId: number, deleteOriginal: boolean, combine = false) {
    const row = await this.row(videoId);
    if (!row) throw new NotFoundError("This recording has not been analysed");
    if (row.status === "rendering") throw new BadRequestError("Clips are being rendered");
    const settings = await this.settings();
    if (!settings.clipsDirectoryId) throw new BadRequestError("No library directory to render clips into");
    const source = await videosService.findById(videoId, userId);
    const duration = env.DEMO_MODE ? source.duration_seconds ?? Infinity : await probeRecordingDuration(source.file_path, source.duration_seconds ?? Infinity);
    const boundedClips = capRecordingClips(row.clips, duration);
    const stem = basename(source.file_name).replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
    const output = (fileName: string) => ({
      directory_id: settings.clipsDirectoryId!,
      file_name: fileName,
      format: "mkv" as const,
      video_codec: "av1" as const,
      audio_codec: "opus" as const,
    });
    const todo = (clip: RecordingClip) => clip.keep && !clip.output_video_id && !clip.job_id;
    let clips: RecordingClip[];
    if (combine) {
      const pending = boundedClips.filter(todo);
      if (!pending.length) throw new BadRequestError("Keep at least one highlight first");
      const job = await editsService.create(videoId, {
        output: output(`${stem}_highlights_${Date.now().toString(36)}.mkv`),
        timeline: { segments: joinStretches(pending) },
      });
      clips = boundedClips.map((clip) => (todo(clip) ? { ...clip, job_id: job.id } : clip));
    } else {
      clips = [];
      for (const clip of boundedClips) {
        if (!todo(clip)) {
          clips.push(clip);
          continue;
        }
        const at = new Date(clip.start_seconds * 1000).toISOString().slice(11, 19).replace(/:/g, "-");
        const job = await editsService.create(videoId, {
          output: output(`${stem}_highlight_${at}.mkv`),
          timeline: { segments: [{ start: clip.start_seconds, end: clip.end_seconds }] },
        });
        clips.push({ ...clip, job_id: job.id });
      }
    }
    await this.save({ ...row, clips, deleteOriginal, status: "rendering", error: null });
    await this.recordDecisions(row, source, clips, true);
    startFinalizer();
    return this.review(userId, videoId);
  }

  /**
   * Once every clip job has finished: give the clips the source's creators and tags, then
   * (if asked) delete the original — through GoondVR when it owns the file.
   */
  async finalize(videoId: number): Promise<ReviewRow | null> {
    const row = await this.row(videoId);
    if (!row || row.status !== "rendering") return row;
    const clips: RecordingClip[] = [];
    let pending = false;
    const failures: string[] = [];
    for (const clip of row.clips) {
      if (!clip.job_id || clip.output_video_id) {
        clips.push(clip);
        continue;
      }
      const job = await editsService.getById(clip.job_id).catch(() => null);
      if (!job || job.status === "failed" || job.status === "cancelled") {
        failures.push(job?.errorMessage ?? `Job ${clip.job_id} did not finish`);
        clips.push({ ...clip, job_id: null });
      } else if (job.status === "completed" && job.outputVideoId) {
        clips.push({ ...clip, output_video_id: job.outputVideoId });
      } else {
        pending = true;
        clips.push(clip);
      }
    }
    if (pending) {
      const next = { ...row, clips };
      await this.save(next);
      return next;
    }
    // A combined render gives every clip the same output.
    const outputs = [...new Set(clips.flatMap((clip) => (clip.output_video_id ? [clip.output_video_id] : [])))];
    const source = await videosService.findById(videoId, undefined, ["creators", "tags"]).catch(() => null);
    if (source && outputs.length) {
      const creatorIds = (source.creators ?? []).map((creator) => creator.id);
      const tagIds = (source.tags ?? []).map((tag) => tag.id);
      if (creatorIds.length) await videosBulkService.bulkUpdateCreators({ videoIds: outputs, creatorIds, action: "add" });
      if (tagIds.length) await videosBulkService.bulkUpdateTags({ videoIds: outputs, tagIds, action: "add" });
    }
    const done: ReviewRow = { ...row, clips, status: failures.length ? "proposed" : "done", error: failures[0] ?? null };
    await this.save(done);
    if (!failures.length && row.deleteOriginal && source && outputs.length) await this.deleteOriginal(source);
    return done;
  }

  private async deleteOriginal(source: Video) {
    try {
      await this.remove(source);
    } catch (error) {
      logger.warn({ error, videoId: source.id }, "Could not delete the original recording");
    }
  }

  /**
   * Throws a whole recording away from its review, when nothing in it is worth keeping.
   * Clips already rendered from it stay in the library.
   */
  async discard(userId: number, videoId: number) {
    if ((await this.row(videoId))?.status === "rendering") throw new BadRequestError("Clips are still being rendered from this recording");
    await this.remove(await videosService.findById(videoId, userId));
    demoReviews.delete(videoId);
    await markRecordingDiscarded(videoId).catch((error) => logger.warn({ error, videoId }, "Could not mark review decisions discarded"));
    return { video_id: videoId };
  }

  /** Through GoondVR when it owns the file, so its per-channel quota counters stay truthful. */
  private async remove(source: Video) {
    // The demo drives the real GoondVR, but its library videos are never GoondVR's files.
    const owned = env.DEMO_MODE ? undefined : (await goondvr.recordings()).find((recording) => recording.name === source.file_name);
    if (owned?.active) throw new BadRequestError("GoondVR is still recording this file");
    if (owned && !(await goondvr.deleteRecording(owned.id))) throw new BadRequestError("GoondVR could not delete the recording");
    await videosService.delete(source.id);
  }

  async renderingIds(): Promise<number[]> {
    if (env.DEMO_MODE) return [...demoReviews.values()].filter((row) => row.status === "rendering").map((row) => row.videoId);
    const rows = await db
      .select({ videoId: recordingReviewsTable.videoId })
      .from(recordingReviewsTable)
      .where(eq(recordingReviewsTable.status, "rendering"));
    return rows.map((row) => row.videoId);
  }

  /** New recordings are analysed as soon as their frames are indexed. */
  async autoAnalyze(videoId: number) {
    const settings = await this.settings();
    if (!settings.directoryId) return;
    const video = await videosService.findById(videoId).catch(() => null);
    if (!video || video.directory_id !== settings.directoryId) return;
    if (await this.row(videoId)) return;
    const userId = 1;
    await this.analyze(userId, videoId).catch((error) =>
      logger.warn({ error, videoId }, "Automatic highlight analysis failed")
    );
  }
}

let finalizer: ReturnType<typeof setInterval> | null = null;
/** Polls rendering reviews until none are left, then stops. */
function startFinalizer() {
  if (finalizer) return;
  finalizer = setInterval(async () => {
    try {
      const ids = await recordingsService.renderingIds();
      if (!ids.length && finalizer) {
        clearInterval(finalizer);
        finalizer = null;
      }
      for (const id of ids) await recordingsService.finalize(id);
    } catch (error) {
      logger.warn({ error }, "Recording clip finalizer failed");
    }
  }, 15_000);
  finalizer.unref?.();
}

export const recordingsService = new RecordingsService();
