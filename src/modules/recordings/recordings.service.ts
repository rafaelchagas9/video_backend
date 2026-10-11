import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { recordingReviewsTable, type RecordingClip, type RecordingProposal } from "@/database/schema";
import { editsService } from "@/modules/edits/edits.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { settingsService } from "@/modules/settings/settings.service";
import { videosBulkService } from "@/modules/videos/videos.bulk.service";
import { videosSearchService } from "@/modules/videos/videos.search.service";
import { videosService } from "@/modules/videos/videos.service";
import type { Video } from "@/modules/videos/videos.types";
import { indexVideoVisually } from "@/modules/visual-search/visual-search.jobs";
import { visualSearchService, visualSearchStore } from "@/modules/visual-search/visual-search.service";
import { BadRequestError, ConflictError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { goondvr, usernameFromFileName } from "./recordings.goondvr";
import { recorderService } from "./recordings.live";
import { demoHighlightAnalysis } from "./recordings.demo-fixtures";
import { detectHighlights, detectWithProbe, isLikelySkip, joinStretches } from "./recordings.highlights";
import { loadHighlightProbe, PROBE_STATES, probeThreshold, type HighlightProbe, type ProbeState } from "./recordings.probe";
import { capRecordingClips, probeRecordingDuration } from "./recordings.duration";
import { DEMO_RECORDING_MIN_SECONDS, recordingScope } from "./recordings.scope";
import { recordingModelReview, loadRecordingModel } from "./recordings.model";
import { readRecordingTemporalVersions } from "./recordings.temporal-cache";
import { recordingTemporalReview, recordingTemporalOriginalProposals, type RecordingTemporalMetadata } from "./recordings.temporal-runtime";
import { eventsService } from "@/modules/events/events.service";
import { enqueueRecordingAudio, RECORDING_AUDIO_PIN } from "./recordings.audio-cache";
import { channelKeeps, confirmedDecisions, feedbackSummary, markRecordingDiscarded, recordFeedback, type SaveContext } from "./recordings.feedback";
import { recorderAutopilot } from "./recordings.autopilot";
import { isAuditRecording, trainingValues } from "./recordings.training-value";
import { preserveRecordingTrainingSnapshot } from "./recordings.snapshots.store";
import { keptRecordingSeconds } from "./recordings.kept-duration";

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
  /** The analysis' proposals as shown; null on reviews older than the column. */
  proposals: RecordingProposal[] | null;
  /** When the reviewer first confirmed this analysis; null while only proposed. */
  savedAt: Date | null;
  deleteOriginal: boolean;
  error: string | null;
  analyzedAt: Date;
}

/** Where the reviewer opened the recording from, as the client tells it. */
export interface ReviewOrigin {
  /** The review this Save answers; a different analysis since then is a conflict. */
  analyzedAt?: string | undefined;
  queuePosition?: number | undefined;
  queueSort?: string | undefined;
  /** The order the reviewer stepped through highlights in: best | timeline. */
  reviewOrder?: string | undefined;
}

/* Demo reviews live in memory: the demo database resets on every start anyway. */
const demoReviews = new Map<number, ReviewRow>();

/**
 * One analysis at a time per recording, whoever asks: the processing queue, a finished index
 * and the review page share the run already going instead of starting a second one.
 */
const analyses = new Map<number, Promise<ReviewRow | null>>();

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

  /**
   * Writes a review only if it still answers the analysis `expected` (null: there was no review),
   * so a run that started before someone saved or re-analysed cannot overwrite their review.
   */
  private async saveIfCurrent(row: ReviewRow, expected: Date | null): Promise<boolean> {
    if (env.DEMO_MODE) {
      const current = demoReviews.get(row.videoId);
      if ((current?.analyzedAt.getTime() ?? null) !== (expected?.getTime() ?? null)) return false;
      demoReviews.set(row.videoId, row);
      return true;
    }
    const values = { ...row, updatedAt: new Date() };
    const written = expected
      ? await db
          .update(recordingReviewsTable)
          .set(values)
          .where(and(eq(recordingReviewsTable.videoId, row.videoId), eq(recordingReviewsTable.analyzedAt, expected)))
          .returning({ videoId: recordingReviewsTable.videoId })
      : await db.insert(recordingReviewsTable).values(values).onConflictDoNothing().returning({ videoId: recordingReviewsTable.videoId });
    return written.length > 0;
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
    const [reviews, paired, autopilot, knownSites] = await Promise.all([
      this.rows(videos.map((video) => video.id)),
      this.pairedByChannel(),
      recorderAutopilot.settings(),
      this.knownChannelSites(),
    ]);
    const channelOf = (video: Video) => usernameFromFileName(video.file_name)?.replace(/^@/, "").toLowerCase() ?? null;
    // Channels removed from GoondVR keep their site in the autopilot's table.
    const siteOf = new Map([...knownSites, ...(channels ?? []).map((channel) => [channel.username.replace(/^@/, "").toLowerCase(), channel.site] as const)]);
    const values = trainingValues(
      videos.flatMap((video) => {
        const review = reviews.get(video.id);
        const status = review?.status ?? "pending";
        if (status !== "pending" && status !== "proposed") return [];
        return [{ videoId: video.id, status, clips: review?.clips ?? null, channel: channelOf(video) }];
      }),
      paired,
      autopilot.enoughUseful
    );
    return {
      goondvr: { reachable: channels !== null, channels: linked },
      directory_id: settings.directoryId,
      recordings: videos.map((video) => {
        const review = reviews.get(video.id);
        const channel = channelOf(video);
        return {
          video,
          status: review?.status ?? "pending",
          clip_count: review?.clips.length ?? 0,
          kept_count: review?.clips.filter((clip) => clip.keep).length ?? 0,
          kept_seconds: keptRecordingSeconds(review?.clips ?? [], video.duration_seconds),
          channel,
          site: (channel && siteOf.get(channel)) || null,
          channel_paired: channel ? (paired.get(channel) ?? 0) : 0,
          training_value: values.get(video.id) ?? 0,
          audit: isAuditRecording(video.id),
        };
      }),
    };
  }

  /** Sites of every channel the autopilot has seen, by lower-cased username, from its `<site>__<username>` ids. */
  private async knownChannelSites(): Promise<[string, string][]> {
    if (env.DEMO_MODE) return [];
    const rows = await db.execute<{ channel_id: string }>(sql`SELECT channel_id FROM recorder_autopilot_channels`);
    return rows.flatMap((row) => {
      const [site, ...rest] = String(row.channel_id).split("__");
      return site && rest.length ? [[rest.join("__").replace(/^@/, "").toLowerCase(), site] as [string, string]] : [];
    });
  }

  /** Reviewed recordings with both a kept and a skipped highlight, per lower-cased channel. */
  private async pairedByChannel(): Promise<Map<string, number>> {
    if (env.DEMO_MODE) return new Map();
    const rows = await db.execute<{ channel: string; paired: number }>(sql`
      SELECT channel, count(*)::int AS paired FROM (
        SELECT lower(regexp_replace(f.channel, '^@', '')) AS channel FROM ${confirmedDecisions} f
        WHERE f.channel IS NOT NULL GROUP BY 1, f.video_id
        HAVING bool_or(f.verdict = 'keep') AND bool_or(f.verdict = 'skip')
      ) t GROUP BY channel`);
    return new Map(rows.map((row) => [String(row.channel), Number(row.paired)]));
  }

  /**
   * Proposes highlights for a recording. Asked by hand, it starts a new analysis generation even
   * over a saved review (whose decisions stay in the feedback rows and the training snapshot);
   * `automatic` callers leave any existing review alone. Either way a review that changes while
   * the analysis runs is never overwritten.
   */
  async analyze(userId: number, videoId: number, options: { automatic?: boolean } = {}) {
    const running = analyses.get(videoId);
    if (running) {
      await running.catch(() => null);
      return this.review(userId, videoId);
    }
    const run = this.runAnalysis(userId, videoId, options.automatic ?? false);
    analyses.set(videoId, run);
    try {
      await run;
    } finally {
      if (analyses.get(videoId) === run) analyses.delete(videoId);
    }
    return this.review(userId, videoId);
  }

  /** GoondVR still writing the file: its frames would end where the write had got to. */
  async assertFinished(video: Pick<Video, "file_name">) {
    if (env.DEMO_MODE) return;
    const owned = (await goondvr.recordings()).find((recording) => recording.name === video.file_name);
    if (owned?.active) throw new BadRequestError("GoondVR is still recording this file; it is analysed once it is finished");
  }

  private async runAnalysis(userId: number, videoId: number, automatic: boolean): Promise<ReviewRow | null> {
    const before = await this.row(videoId);
    if (automatic && before) return before;
    const video = await videosService.findById(videoId, userId);
    await this.assertFinished(video);
    if (env.DEMO_MODE) {
      const duration = video.duration_seconds ?? 0;
      if (!Number.isFinite(duration) || duration <= 0) throw new BadRequestError("This demo video has no duration");
      const { clips, curve } = demoHighlightAnalysis(duration);
      const row: ReviewRow = {
        videoId, status: clips.length ? "proposed" : "dismissed", clips, curve,
        promptsRevision: "demo:prompts", proposals: clips, savedAt: null, deleteOriginal: false,
        error: null, analyzedAt: new Date(Math.max(Date.now(), (before?.analyzedAt.getTime() ?? 0) + 1)),
      };
      if (!(await this.saveIfCurrent(row, before?.analyzedAt ?? null))) throw new ConflictError("The review changed while it was being analysed; reload it before analysing again");
      return row;
    }
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
    let frames = await store.videoFrames(videoId);
    const catalogDuration = video.duration_seconds ?? frames.timestamps.at(-1) ?? 0;
    const duration = env.DEMO_MODE ? catalogDuration : await probeRecordingDuration(video.file_path, catalogDuration);
    // An index built while the file was still being written stops early: rebuild it from the
    // finished file once, rather than analysing (and archiving) half a recording.
    const covers = () => (frames.timestamps.at(-1) ?? -Infinity) + (indexed?.intervalSeconds ?? 0) * 2 >= duration;
    if (!env.DEMO_MODE && frames.timestamps.length && !covers()) {
      logger.info({ videoId, indexedTo: frames.timestamps.at(-1), duration }, "Re-indexing a recording indexed before it finished");
      await storyboardsService.delete(videoId).catch(() => undefined);
      await indexVideoVisually(videoId, AbortSignal.timeout(30 * 60_000));
      indexed = (await store.indexed([videoId])).get(videoId);
      frames = await store.videoFrames(videoId);
      if (!covers()) throw new BadRequestError("The recording's visual index does not cover the whole file");
    }
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
    const clips: RecordingClip[] = result.clips.map((clip, index) => ({
      ...clip,
      id: `c${index + 1}`,
      keep: !(useProbe && isLikelySkip(clip)),
      detected: { start_seconds: clip.start_seconds, end_seconds: clip.end_seconds },
    }));
    const row: ReviewRow = {
      videoId,
      status: clips.length ? "proposed" : "dismissed",
      clips,
      curve: result.curve,
      promptsRevision: revisionOf(settings, useProbe ? "trained" : "prompts"),
      proposals: clips.map(({ id, start_seconds, end_seconds, peak_seconds, score, label, keep }) => ({ id, start_seconds, end_seconds, peak_seconds, score, label, keep })),
      savedAt: null,
      deleteOriginal: false,
      error: null,
      analyzedAt: new Date(),
    };
    if (!(await this.saveIfCurrent(row, before?.analyzedAt ?? null))) {
      // Someone saved, rendered or re-analysed while this ran: theirs stands.
      if (automatic) return this.row(videoId);
      throw new ConflictError("The review changed while it was being analysed; reload it before analysing again");
    }
    if (!env.DEMO_MODE && indexed && row.proposals) {
      // A separate bounded worker owns decoding; this only writes a private generation job.
      void loadRecordingModel().then((model) => model?.artifact.heads.audio_acceptance?.gate_passed && model.artifact.model_revision === indexed!.modelRevision ? enqueueRecordingAudio({ identity: { video_id: videoId, analyzed_at: row.analyzedAt.toISOString(), index_model_revision: indexed!.modelRevision, storyboard_generated_at: indexed!.storyboardGeneratedAt.toISOString(), frame_count: indexed!.frameCount, audio_model_revision: RECORDING_AUDIO_PIN }, proposals: row.proposals!, source: { path: video.file_path, sizeBytes: video.file_size_bytes } }) : false).catch(() => logger.warn({ videoId }, "Could not queue recording audio features"));
    }
    if (!env.DEMO_MODE) void this.prepareTemporalReview(userId, videoId).catch(() => undefined);
    await this.linkChannelCreator(video);
    return row;
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
    if (!row)
      return { video, status: "pending", clips: [], curve: [], delete_original: false, error: null, analyzed_at: null, detector: null, order: null, channel: null, model: null };
    if (env.DEMO_MODE) {
      return {
        video, detector: "prompts" as const, status: row.status, clips: row.clips, curve: row.curve,
        delete_original: row.deleteOriginal, error: row.error, analyzed_at: row.analyzedAt.toISOString(),
        order: null, model: null, temporal_versions: null, channel: null,
      };
    }
    const ranked = row.proposals ?? row.clips.map((clip) => ({ ...clip, ...(clip.detected ?? {}) }));
    const channel = video ? usernameFromFileName(video.file_name) : null;
    const model = await recordingModelReview({ videoId, analyzedAt: row.analyzedAt.toISOString(), duration: video?.duration_seconds ?? 0, proposals: ranked, source: video ? { path: video.file_path, sizeBytes: video.file_size_bytes } : undefined, store: visualSearchStore() });
    const currentPrepared = await this.prepareTemporalReview(userId, videoId);
    const prepared = currentPrepared?.versions.analyzed_at === row.analyzedAt.toISOString() ? currentPrepared : null;
    const temporal = prepared?.versions ?? await readRecordingTemporalVersions({ videoId, analyzedAt: row.analyzedAt.toISOString(), duration: video?.duration_seconds ?? 0, proposals: ranked, source: video ? { path: video.file_path, sizeBytes: video.file_size_bytes } : undefined, index: async () => (await visualSearchStore().indexed([videoId])).get(videoId) });
    if (prepared && model.assessment) model.assessment = { ...model.assessment, cuts: prepared.cuts };

    return {
      video,
      detector: detectorOf(row.promptsRevision),
      status: row.status,
      clips: row.clips,
      curve: row.curve,
      delete_original: row.deleteOriginal,
      error: row.error,
      analyzed_at: row.analyzedAt.toISOString(),
      // A validated ranking head may reorder the original proposals; decisions and edges stay as saved.
      order: model.order,
      model: model.assessment,
      temporal_versions: temporal,
      // What the channel already holds, so a keep can be refined relative to it.
      channel: channel ? await this.channelContext(channel, videoId) : null,
    };
  }

  private async prepareTemporalReview(userId: number, videoId: number) {
    return recordingTemporalReview({
      metadata: async (): Promise<RecordingTemporalMetadata | null> => {
        const [row, video, indexed, storyboard] = await Promise.all([this.row(videoId), videosService.findById(videoId, userId).catch(() => null), visualSearchStore().indexed([videoId]), storyboardsService.findByVideoId(videoId)]);
        const index = indexed.get(videoId) as (RecordingTemporalMetadata["index"] | undefined);
        const proposals = row ? recordingTemporalOriginalProposals(row.proposals,row.clips) : null;
        if (!row || !proposals?.length || !video?.duration_seconds || !index?.indexedAt || !storyboard) return null;
        return { videoId, analyzedAt: row.analyzedAt.toISOString(), duration: video.duration_seconds, proposals, source: {path:video.file_path,sizeBytes:video.file_size_bytes}, index, storyboard };
      },
      frames: () => visualSearchStore().videoFrames(videoId),
      onReady: id => eventsService.broadcastToAuthenticated({type:"recordings:model-ready",message:{video_ids:[id]}}),
    });
  }

  private async channelContext(name: string, videoId: number) {
    const keeps = await channelKeeps(name, videoId);
    return {
      name,
      kept_clips: keeps.keptClips,
      kept_seconds: keeps.keptSeconds,
      worth_saving: keeps.worthSaving,
      nice_to_watch: keeps.niceToWatch,
    };
  }

  /** Save confirms every current choice, untouched defaults included. */
  async updateClips(userId: number, videoId: number, clips: RecordingClip[], origin: ReviewOrigin = {}) {
    const row = await this.row(videoId);
    if (!row) throw new NotFoundError("This recording has not been analysed");
    if (row.status === "rendering") throw new BadRequestError("Clips are being rendered");
    if (origin.analyzedAt && Date.parse(origin.analyzedAt) !== row.analyzedAt.getTime())
      throw new ConflictError("This recording was analysed again since you opened it; reload it to review the new highlights");
    const video = await videosService.findById(videoId, userId);
    const duration = video.duration_seconds ?? Infinity;
    for (const clip of clips)
      if (!(clip.end_seconds > clip.start_seconds) || clip.start_seconds < 0 || clip.end_seconds > duration + 1)
        throw new BadRequestError("Every clip must end after it starts, inside the recording");
    // Clips added by hand were never detected; a merge sends back the pair's combined proposal.
    // A skipped clip carries no refinement.
    const next = clips.map((clip) => {
      const { refinement, ...base } = clip;
      const refined = clip.keep && refinement ? { ...base, refinement } : base;
      if (!clip.id.startsWith("added-")) return refined;
      const { detected: _detected, ...rest } = refined;
      return rest;
    });
    const reviewed: ReviewRow = { ...row, clips: next, status: next.some((clip) => clip.keep) ? "proposed" : "dismissed", savedAt: row.savedAt ?? new Date() };
    const context: SaveContext = {
      batch: randomUUID(),
      queuePosition: origin.queuePosition ?? null,
      queueSort: origin.queueSort ?? null,
      audit: isAuditRecording(videoId),
      reviewOrder: origin.reviewOrder ?? null,
    };
    // Archive every current choice before acknowledging the Save.
    await preserveRecordingTrainingSnapshot(reviewed, video, "save", context);
    if (!(await this.saveIfCurrent(reviewed, row.analyzedAt)))
      throw new ConflictError("This recording was analysed again while saving; reload it to review the new highlights");
    await this.recordDecisions(row, video, next, false, context);
    return this.review(userId, videoId);
  }

  /** Training data for what is worth keeping; a failure here never loses the review itself. */
  private async recordDecisions(row: ReviewRow, video: Video, clips: RecordingClip[], rendered = false, context: SaveContext | null = null) {
    try {
      await recordFeedback(
        {
          videoId: row.videoId,
          analyzedAt: row.analyzedAt,
          promptsRevision: row.promptsRevision,
          fileName: video.file_name,
          durationSeconds: video.duration_seconds ?? null,
          proposals: row.proposals ?? null,
        },
        clips,
        { rendered, context }
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
    // Refuse to start new jobs when the reviewed training data cannot be retained.
    await preserveRecordingTrainingSnapshot({ ...row, clips: boundedClips }, source, "render-requested");
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
    const rendering: ReviewRow = { ...row, clips, deleteOriginal, status: "rendering", error: null };
    // Jobs now exist: persist their IDs before any optional lineage update can fail.
    await this.save(rendering);
    try {
      await preserveRecordingTrainingSnapshot(rendering, source, "rendering");
    } catch (error) {
      rendering.error = "Rendering started, but the training snapshot lineage could not be updated. The original is retained until the archive is available.";
      await this.save(rendering);
      logger.warn({ error, videoId }, "Could not update rendering training snapshot");
    }
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
    // Completed jobs remain completed even when archive storage is temporarily unavailable.
    await this.save(done);
    let archived = false;
    if (source) {
      try {
        await preserveRecordingTrainingSnapshot(done, source, "render-finished");
        archived = true;
      } catch (error) {
        done.error = failures[0] ?? "Clips finished, but the training snapshot lineage could not be updated. The original has been retained.";
        await this.save(done);
        logger.warn({ error, videoId }, "Could not update completed training snapshot; original retained");
      }
    }
    if (!failures.length && archived && row.deleteOriginal && source && outputs.length) await this.deleteOriginal(source);
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
    const review = await this.row(source.id);
    if (review) await preserveRecordingTrainingSnapshot(review, source, "before-delete");
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
    await this.analyze(userId, videoId, { automatic: true }).catch((error) =>
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

/** Picks up reviews left rendering by a restart; until now only opening one would finish it. */
export async function resumeRecordingRenders(): Promise<void> {
  try {
    if ((await recordingsService.renderingIds()).length) startFinalizer();
  } catch (error) {
    logger.warn({ error }, "Could not resume rendering recordings");
  }
}
