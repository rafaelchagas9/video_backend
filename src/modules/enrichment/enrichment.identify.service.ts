/**
 * Batch identify, modeled on Stash's Identify task (internal/identify): ordered
 * sources, a strategy per field, `createMissing` per relation, and a review
 * tag for videos it will not decide. Stricter than Stash's default: a match is
 * applied only when it is the only one and its fingerprints agree (pHash and
 * duration). Everything else becomes ordinary pending proposals.
 *
 * Auto-applied proposals go through the same accept path as a manual review,
 * so `POST /enrichment/scene/:id/reset` undoes a run video by video.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  enrichmentSuggestionsTable,
  identifyRunItemsTable,
  identifyRunsTable,
  stashSceneLinksTable,
  videoCreatorsTable,
  videoExternalIdsTable,
  videoFingerprintsTable,
  videoMetadataTable,
  videoStudiosTable,
  videoTagsTable,
  videosTable,
  type EnrichmentSuggestion,
  type IdentifyRun,
  type IdentifyRunItem,
} from "@/database/schema";
import type {
  DurableJob,
  DurableJobHandlerContext,
} from "@/modules/durable-jobs";
import { eventsService } from "@/modules/events/events.service";
import { settingsService } from "@/modules/settings/settings.service";
import { stashLinkService } from "@/modules/stash/stash-link.service";
import { stashDemo } from "@/modules/stash/stash.demo";
import { getStashRuntime, IDENTIFY_JOB_KIND } from "@/modules/stash/stash.runtime";
import { tagsService } from "@/modules/tags/tags.service";
import { BadRequestError, ConflictError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { getEnrichmentClient } from "./enrichment.client";
import { enrichmentService } from "./enrichment.service";
import type { Candidate, EnrichRequest, EnrichResponse, RelationalRaw } from "./enrichment.types";

const CHUNK = 20;
const DURATION_TOLERANCE_SECONDS = 5;

export const IDENTIFY_FIELDS = [
  "title",
  "description",
  "release_date",
  "code",
  "director",
  "url",
  "cover",
] as const;
type IdentifyField = (typeof IDENTIFY_FIELDS)[number];

const strategy = z.enum(["ignore", "merge", "overwrite"]);
const relation = z.object({
  mode: z.enum(["ignore", "merge"]),
  create_missing: z.boolean(),
});

export const identifyOptionsSchema = z.object({
  /** Tried in order; the first source with a match is used. */
  sources: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(10),
  fields: z.object(
    Object.fromEntries(IDENTIFY_FIELDS.map((field) => [field, strategy])) as Record<
      IdentifyField,
      typeof strategy
    >
  ),
  performers: relation,
  /** merge = only when the video has no studio yet. */
  studio: relation,
  tags: relation,
  /** Require a pHash match (an exact OSHASH/MD5 match also counts). */
  require_phash: z.boolean(),
  /** Tag put on videos left for manual review; empty = no tag. */
  review_tag: z.string().max(255),
});
export type IdentifyOptions = z.infer<typeof identifyOptionsSchema>;

export const DEFAULT_IDENTIFY_OPTIONS: IdentifyOptions = {
  sources: ["stashdb", "fansdb", "theporndb"],
  fields: {
    title: "merge",
    description: "merge",
    release_date: "merge",
    code: "merge",
    director: "merge",
    url: "merge",
    cover: "merge",
  },
  performers: { mode: "merge", create_missing: true },
  studio: { mode: "merge", create_missing: true },
  tags: { mode: "merge", create_missing: false },
  require_phash: true,
  review_tag: "identify: needs review",
};

export const identifyFilterSchema = z
  .object({
    video_ids: z.array(z.number().int().positive()).max(10_000).optional(),
    directory_id: z.number().int().positive().optional(),
    studio_id: z.number().int().positive().optional(),
    creator_id: z.number().int().positive().optional(),
    /** Skip videos that already have a source ID. */
    unidentified_only: z.boolean().default(true),
    limit: z.number().int().positive().max(10_000).default(500),
  })
  .strict();
export type IdentifyFilter = z.infer<typeof identifyFilterSchema>;

export interface IdentifyCounts {
  total: number;
  processed: number;
  applied: number;
  queued: number;
  no_match: number;
  unlinked: number;
  errors: number;
}

type Outcome = "applied" | "queued" | "no_match" | "unlinked" | "error";

interface PlannedAction {
  suggestion_id?: number;
  type: string;
  field_key?: string | null;
  value: string;
  action: "accept" | "skip";
  reason?: string;
}

export interface IdentifyRunDTO {
  id: number;
  status: string;
  dry_run: boolean;
  options: IdentifyOptions;
  filter: Omit<IdentifyFilter, "video_ids"> & { video_count: number };
  counts: IdentifyCounts;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface IdentifyItemDTO {
  id: number;
  video_id: number;
  outcome: string;
  source: string | null;
  external_id: string | null;
  detail: unknown;
  created_at: string;
}

const EMPTY_COUNTS: IdentifyCounts = {
  total: 0,
  processed: 0,
  applied: 0,
  queued: 0,
  no_match: 0,
  unlinked: 0,
  errors: 0,
};

/** Fields a scene proposal writes, keyed by its `field_key`. */
const FIELD_BY_KEY: Record<string, IdentifyField> = {
  title: "title",
  description: "description",
  release_date: "release_date",
  code: "code",
  director: "director",
  url: "url",
};

function matchOf(raw: unknown): {
  source?: string;
  external_id?: string | null;
  rank?: number;
  evidence?: Record<string, number | boolean | null>;
  name?: string | null;
} {
  const match = (raw as { match?: unknown } | null)?.match;
  return match && typeof match === "object" ? (match as never) : {};
}

/** Is this the only match, and do its fingerprints agree with the file? */
export function judgeMatch(
  matches: Candidate[],
  requirePhash: boolean
): { strong: boolean; reason: string } {
  if (matches.length > 1) {
    return { strong: false, reason: `${matches.length} matches` };
  }
  const evidence = matchOf(matches[0]?.raw).evidence;
  if (!evidence) return { strong: false, reason: "no fingerprint evidence" };
  const exact = evidence.exact_hash === true;
  const phash = Number(evidence.phash_matches ?? 0) > 0;
  const durationDiff = Number(
    evidence.scene_duration_diff ?? evidence.min_duration_diff ?? Number.POSITIVE_INFINITY
  );
  if (!exact && requirePhash && !phash) {
    return { strong: false, reason: "no pHash match" };
  }
  if (!exact && !phash && Number(evidence.duration_matches ?? 0) === 0) {
    return { strong: false, reason: "no fingerprint agrees" };
  }
  if (!exact && !(durationDiff <= DURATION_TOLERANCE_SECONDS)) {
    return { strong: false, reason: "duration differs" };
  }
  return { strong: true, reason: exact ? "exact hash" : "pHash and duration agree" };
}

export class IdentifyService {
  async getOptions(): Promise<IdentifyOptions> {
    const stored = await settingsService.getValue("identify_options");
    if (typeof stored !== "string" || !stored.trim()) return DEFAULT_IDENTIFY_OPTIONS;
    try {
      return this.mergeOptions(JSON.parse(stored));
    } catch {
      return DEFAULT_IDENTIFY_OPTIONS;
    }
  }

  async saveOptions(input: unknown): Promise<IdentifyOptions> {
    const options = this.mergeOptions(input);
    await settingsService.updateValues({ identify_options: JSON.stringify(options) });
    return options;
  }

  mergeOptions(input: unknown): IdentifyOptions {
    const value = (input ?? {}) as Partial<IdentifyOptions>;
    const parsed = identifyOptionsSchema.safeParse({
      ...DEFAULT_IDENTIFY_OPTIONS,
      ...value,
      fields: { ...DEFAULT_IDENTIFY_OPTIONS.fields, ...(value.fields ?? {}) },
      performers: { ...DEFAULT_IDENTIFY_OPTIONS.performers, ...(value.performers ?? {}) },
      studio: { ...DEFAULT_IDENTIFY_OPTIONS.studio, ...(value.studio ?? {}) },
      tags: { ...DEFAULT_IDENTIFY_OPTIONS.tags, ...(value.tags ?? {}) },
    });
    if (!parsed.success) {
      throw new BadRequestError(`Invalid identify options: ${parsed.error.issues[0]?.message ?? ""}`);
    }
    return parsed.data;
  }

  async resolveVideoIds(filter: IdentifyFilter): Promise<number[]> {
    const conditions = [eq(videosTable.isAvailable, true)];
    if (filter.video_ids?.length) conditions.push(inArray(videosTable.id, filter.video_ids));
    if (filter.directory_id) conditions.push(eq(videosTable.directoryId, filter.directory_id));
    if (filter.studio_id) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${videoStudiosTable} WHERE ${videoStudiosTable.videoId} = ${videosTable.id} AND ${videoStudiosTable.studioId} = ${filter.studio_id})`
      );
    }
    if (filter.creator_id) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${videoCreatorsTable} WHERE ${videoCreatorsTable.videoId} = ${videosTable.id} AND ${videoCreatorsTable.creatorId} = ${filter.creator_id})`
      );
    }
    if (filter.unidentified_only) {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${videoExternalIdsTable} WHERE ${videoExternalIdsTable.videoId} = ${videosTable.id})`
      );
    }
    const rows = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(and(...conditions))
      .orderBy(videosTable.id)
      .limit(filter.limit);
    return rows.map((row) => row.id);
  }

  async start(input: {
    filter: unknown;
    options?: unknown;
    dry_run?: boolean;
  }): Promise<IdentifyRunDTO> {
    const filter = identifyFilterSchema.parse(input.filter ?? {});
    const options =
      input.options === undefined
        ? await this.getOptions()
        : this.mergeOptions(input.options);
    if (env.DEMO_MODE) {
      return stashDemo.startIdentify(filter, options, input.dry_run ?? false);
    }
    const videoIds = await this.resolveVideoIds(filter);
    if (videoIds.length === 0) throw new BadRequestError("No videos match this filter");
    const [run] = await db
      .insert(identifyRunsTable)
      .values({
        status: "queued",
        dryRun: input.dry_run ?? false,
        options,
        filter: { ...filter, video_ids: videoIds },
        counts: { ...EMPTY_COUNTS, total: videoIds.length },
      })
      .returning();
    const job = await getStashRuntime().durableJobs.enqueue({
      kind: IDENTIFY_JOB_KIND,
      payload: { run_id: run!.id },
    });
    const [updated] = await db
      .update(identifyRunsTable)
      .set({ durableJobId: job.id })
      .where(eq(identifyRunsTable.id, run!.id))
      .returning();
    return this.toRunDTO(updated!);
  }

  async listRuns(limit = 20): Promise<IdentifyRunDTO[]> {
    if (env.DEMO_MODE) return stashDemo.listRuns();
    const rows = await db
      .select()
      .from(identifyRunsTable)
      .orderBy(desc(identifyRunsTable.id))
      .limit(limit);
    return rows.map((row) => this.toRunDTO(row));
  }

  async getRun(id: number): Promise<IdentifyRunDTO> {
    if (env.DEMO_MODE) return stashDemo.getRun(id);
    return this.toRunDTO(await this.loadRun(id));
  }

  async listItems(
    runId: number,
    query: { outcome?: string; page: number; per_page: number }
  ): Promise<{ items: IdentifyItemDTO[]; total: number }> {
    if (env.DEMO_MODE) return stashDemo.listItems(runId, query);
    await this.loadRun(runId);
    const where = and(
      eq(identifyRunItemsTable.runId, runId),
      query.outcome ? eq(identifyRunItemsTable.outcome, query.outcome) : undefined
    );
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(identifyRunItemsTable)
      .where(where);
    const rows = await db
      .select()
      .from(identifyRunItemsTable)
      .where(where)
      .orderBy(identifyRunItemsTable.id)
      .limit(query.per_page)
      .offset((query.page - 1) * query.per_page);
    return { items: rows.map((row) => this.toItemDTO(row)), total: count?.total ?? 0 };
  }

  async cancel(id: number): Promise<IdentifyRunDTO> {
    if (env.DEMO_MODE) return stashDemo.cancel(id);
    const run = await this.loadRun(id);
    if (!["queued", "running"].includes(run.status)) {
      throw new ConflictError(`Run ${id} is already ${run.status}`);
    }
    if (run.durableJobId) {
      await getStashRuntime().durableJobs.requestCancellation(run.durableJobId);
    }
    const [updated] = await db
      .update(identifyRunsTable)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(identifyRunsTable.id, id))
      .returning();
    return this.toRunDTO(updated!);
  }

  // --- Job ------------------------------------------------------------------

  async handleJob(job: DurableJob, context: DurableJobHandlerContext): Promise<void> {
    const runId = Number((job.payload as { run_id?: unknown }).run_id);
    const run = await this.loadRun(runId);
    if (run.status === "cancelled" || run.status === "completed") return;
    const options = this.mergeOptions(run.options);
    const videoIds = ((run.filter as { video_ids?: number[] }).video_ids ?? []).slice();
    const counts: IdentifyCounts = { ...EMPTY_COUNTS, ...(run.counts as IdentifyCounts) };
    await db
      .update(identifyRunsTable)
      .set({ status: "running", startedAt: run.startedAt ?? new Date() })
      .where(eq(identifyRunsTable.id, runId));

    try {
      for (let start = counts.processed; start < videoIds.length; start += CHUNK) {
        context.signal.throwIfAborted();
        const chunk = videoIds.slice(start, start + CHUNK);
        await this.processChunk(run, options, chunk, counts, context);
        counts.processed = start + chunk.length;
        await db
          .update(identifyRunsTable)
          .set({ counts })
          .where(eq(identifyRunsTable.id, runId));
        await context.checkpoint({
          stage: "identify",
          completedUnits: counts.processed,
          totalUnits: videoIds.length,
        });
        eventsService.broadcast({ type: "identify:progress", message: { run_id: runId, counts } });
      }
      await db
        .update(identifyRunsTable)
        .set({ status: "completed", counts, finishedAt: new Date() })
        .where(and(eq(identifyRunsTable.id, runId), eq(identifyRunsTable.status, "running")));
      eventsService.broadcast({ type: "identify:finished", message: { run_id: runId, counts } });
    } catch (error) {
      const cancelled = context.signal.aborted;
      await db
        .update(identifyRunsTable)
        .set({
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? null : error instanceof Error ? error.message : String(error),
          counts,
          finishedAt: new Date(),
        })
        .where(eq(identifyRunsTable.id, runId));
      if (!cancelled) throw error;
    }
  }

  private async processChunk(
    run: IdentifyRun,
    options: IdentifyOptions,
    videoIds: number[],
    counts: IdentifyCounts,
    context: DurableJobHandlerContext
  ): Promise<void> {
    // Fingerprints first: link and pHash any file Stash has not processed.
    const toSync = await stashLinkService.videosNeedingSync({ ids: videoIds });
    if (toSync.length > 0) {
      await stashLinkService.syncVideos(toSync, {
        signal: context.signal,
        onProgress: () => context.heartbeat(),
      });
    }
    const videos = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        fileName: videosTable.fileName,
        duration: videosTable.durationSeconds,
        stashSceneId: stashSceneLinksTable.stashSceneId,
      })
      .from(videosTable)
      .leftJoin(stashSceneLinksTable, eq(stashSceneLinksTable.videoId, videosTable.id))
      .where(inArray(videosTable.id, videoIds));
    const originals = await db
      .select()
      .from(videoFingerprintsTable)
      .where(
        and(
          inArray(videoFingerprintsTable.videoId, videoIds),
          eq(videoFingerprintsTable.origin, "pre_conversion")
        )
      );

    const linked = videos.filter((video) => video.stashSceneId);
    const requests: EnrichRequest[] = linked.map((video) => ({
      entity_type: "scene",
      name: video.title || video.fileName,
      title: video.title,
      file_name: video.fileName,
      duration_seconds: video.duration,
      stash_scene_id: video.stashSceneId!,
      fingerprints: originals
        .filter((fp) => fp.videoId === video.id)
        .map((fp) => ({
          algorithm: fp.algorithm as "OSHASH",
          hash: fp.hash,
          ...(fp.durationSeconds ? { duration: fp.durationSeconds } : {}),
        })),
      fingerprint_only: true,
      sources: options.sources,
      aliases: [],
      handles: [],
      limit: 5,
    }));
    const responses = requests.length ? await getEnrichmentClient().enrichBatch(requests) : [];
    await context.heartbeat();

    for (const video of videos) {
      if (!video.stashSceneId) {
        await this.recordItem(run.id, video.id, "unlinked", counts, null, null, {
          reason: "Stash has no scene for this file",
        });
        continue;
      }
      const response = responses[linked.indexOf(video)] ?? { candidates: [], sources_used: [], errors: [] };
      try {
        await this.identifyVideo(run, options, video.id, response, counts);
      } catch (error) {
        logger.warn({ runId: run.id, videoId: video.id, error }, "Identify failed for a video");
        await this.recordItem(run.id, video.id, "error", counts, null, null, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async identifyVideo(
    run: IdentifyRun,
    options: IdentifyOptions,
    videoId: number,
    response: EnrichResponse,
    counts: IdentifyCounts
  ): Promise<void> {
    const candidates = await enrichmentService.prepareSceneCandidates(response.candidates);
    let source: string | null = null;
    let matches: Candidate[] = [];
    for (const name of options.sources) {
      const found = candidates
        .filter((c) => c.type === "external_id" && c.source === name)
        .sort((a, b) => (matchOf(a.raw).rank ?? 0) - (matchOf(b.raw).rank ?? 0));
      if (found.length > 0) {
        source = name;
        matches = found;
        break;
      }
    }
    if (!source) {
      await this.recordItem(run.id, videoId, "no_match", counts, null, null, {
        errors: response.errors,
      });
      return;
    }
    const best = matches[0]!;
    const verdict = judgeMatch(matches, options.require_phash);
    const evidence = matchOf(best.raw).evidence ?? null;
    const sourceCandidates = candidates.filter((c) => matchOf(c.raw).source === source);
    const matchCandidates = sourceCandidates.filter(
      (c) => matchOf(c.raw).external_id === best.value
    );

    if (run.dryRun) {
      const plan = verdict.strong ? await this.plan(videoId, matchCandidates, options) : [];
      await this.recordItem(run.id, videoId, verdict.strong ? "applied" : "queued", counts, source, best.value, {
        title: matchOf(best.raw).name,
        reason: verdict.reason,
        matches: matches.length,
        evidence,
        plan,
      });
      return;
    }

    const stored = await this.store(videoId, sourceCandidates, response);
    if (!verdict.strong) {
      await this.tagForReview(videoId, options);
      await this.recordItem(run.id, videoId, "queued", counts, source, best.value, {
        title: matchOf(best.raw).name,
        reason: verdict.reason,
        matches: matches.length,
        evidence,
      });
      return;
    }

    const rows = stored.filter((row) => matchOf(row.raw).external_id === best.value);
    const plan = await this.plan(videoId, rows, options);
    const accepted: number[] = [];
    const left: PlannedAction[] = [];
    for (const step of plan) {
      if (step.action !== "accept" || step.suggestion_id === undefined) {
        left.push(step);
        continue;
      }
      try {
        await enrichmentService.acceptSuggestion(step.suggestion_id);
        accepted.push(step.suggestion_id);
      } catch (error) {
        left.push({ ...step, action: "skip", reason: error instanceof Error ? error.message : "failed" });
      }
    }
    if (left.some((step) => step.reason && /choose|single name/.test(step.reason))) {
      await this.tagForReview(videoId, options);
    }
    await this.recordItem(run.id, videoId, "applied", counts, source, best.value, {
      title: matchOf(best.raw).name,
      reason: verdict.reason,
      evidence,
      accepted,
      left_pending: left,
    });
  }

  /** Store the source's proposals like a manual run, so they can be reviewed. */
  private async store(
    videoId: number,
    candidates: Candidate[],
    response: EnrichResponse
  ): Promise<EnrichmentSuggestion[]> {
    await enrichmentService.recordRun("scene", videoId, {
      candidates,
      sources_used: response.sources_used,
      errors: response.errors,
    });
    return db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, "scene"),
          eq(enrichmentSuggestionsTable.entityId, videoId),
          eq(enrichmentSuggestionsTable.status, "pending")
        )
      )
      .orderBy(enrichmentSuggestionsTable.id);
  }

  /** What the options say to do with each proposal of the chosen match. */
  async plan(
    videoId: number,
    rows: Array<Candidate | EnrichmentSuggestion>,
    options: IdentifyOptions
  ): Promise<PlannedAction[]> {
    const [video] = await db
      .select({ title: videosTable.title, description: videosTable.description })
      .from(videosTable)
      .where(eq(videosTable.id, videoId))
      .limit(1);
    const metadata = new Map(
      (
        await db
          .select({ key: videoMetadataTable.key, value: videoMetadataTable.value })
          .from(videoMetadataTable)
          .where(eq(videoMetadataTable.videoId, videoId))
      ).map((row) => [row.key, row.value])
    );
    const [studio] = await db
      .select({ id: videoStudiosTable.studioId })
      .from(videoStudiosTable)
      .where(eq(videoStudiosTable.videoId, videoId))
      .limit(1);
    const current: Record<IdentifyField, string | null | undefined> = {
      title: video?.title,
      description: video?.description,
      release_date: metadata.get("release_date"),
      code: metadata.get("code"),
      director: metadata.get("director"),
      url: metadata.get("url"),
      cover: metadata.get("cover_image_url"),
    };
    const decide = (field: IdentifyField): PlannedAction["action"] => {
      const rule = options.fields[field];
      if (rule === "ignore") return "skip";
      return rule === "overwrite" || !current[field]?.trim() ? "accept" : "skip";
    };

    const plan: PlannedAction[] = [];
    let coverTaken = false;
    for (const row of rows) {
      const fieldKey = "fieldKey" in row ? row.fieldKey : (row.field_key ?? null);
      const base = {
        ...("id" in row ? { suggestion_id: row.id } : {}),
        type: row.type,
        field_key: fieldKey,
        value: row.value.startsWith("data:") ? "(inline image)" : row.value,
      };
      const raw = (row.raw ?? {}) as RelationalRaw;
      switch (row.type) {
        case "external_id":
          plan.push({ ...base, action: "accept" });
          break;
        case "field": {
          const field = FIELD_BY_KEY[fieldKey ?? ""];
          plan.push(field ? { ...base, action: decide(field) } : { ...base, action: "skip", reason: "unknown field" });
          break;
        }
        case "image": {
          const action: PlannedAction["action"] = !coverTaken ? decide("cover") : "skip";
          coverTaken ||= action === "accept";
          plan.push({ ...base, action });
          break;
        }
        case "performer":
        case "studio":
        case "tag": {
          const kind = row.type === "performer" ? "creator" : row.type;
          const rules = row.type === "performer" ? options.performers : row.type === "studio" ? options.studio : options.tags;
          if (rules.mode === "ignore") {
            plan.push({ ...base, action: "skip", reason: "ignored" });
            break;
          }
          if (row.type === "studio" && studio) {
            plan.push({ ...base, action: "skip", reason: "video already has a studio" });
            break;
          }
          const { match, ambiguous } = await enrichmentService.resolveRelated(
            kind,
            row.value,
            raw.source ?? row.source,
            raw.external_id,
            raw.merged_ids
          );
          if (match) plan.push({ ...base, action: "accept", reason: `links ${match.name}` });
          else if (ambiguous.length) plan.push({ ...base, action: "skip", reason: `choose: ${ambiguous.length} share this name` });
          else if (raw.requires_choice === "single_name") plan.push({ ...base, action: "skip", reason: "single name: choose or create" });
          else if (rules.create_missing) plan.push({ ...base, action: "accept", reason: "creates it" });
          else plan.push({ ...base, action: "skip", reason: "not in the library" });
          break;
        }
        default:
          plan.push({ ...base, action: "skip" });
      }
    }
    return plan;
  }

  private async tagForReview(videoId: number, options: IdentifyOptions): Promise<void> {
    const name = options.review_tag.trim();
    if (!name) return;
    const { match } = await enrichmentService.resolveRelated("tag", name);
    const tagId = match?.id ?? (await tagsService.create({ name })).id;
    await db.insert(videoTagsTable).values({ videoId, tagId }).onConflictDoNothing();
  }

  private async recordItem(
    runId: number,
    videoId: number,
    outcome: Outcome,
    counts: IdentifyCounts,
    source: string | null,
    externalId: string | null,
    detail: unknown
  ): Promise<void> {
    await db.insert(identifyRunItemsTable).values({
      runId,
      videoId,
      outcome,
      source,
      externalId,
      detail,
    });
    counts[outcome === "error" ? "errors" : outcome] += 1;
  }

  private async loadRun(id: number): Promise<IdentifyRun> {
    const [run] = await db.select().from(identifyRunsTable).where(eq(identifyRunsTable.id, id)).limit(1);
    if (!run) throw new NotFoundError(`Identify run not found: ${id}`);
    return run;
  }

  private toRunDTO(row: IdentifyRun): IdentifyRunDTO {
    const { video_ids: videoIds = [], ...filter } = row.filter as IdentifyFilter;
    return {
      id: row.id,
      status: row.status,
      dry_run: row.dryRun,
      options: row.options as IdentifyOptions,
      filter: { ...filter, video_count: videoIds.length },
      counts: { ...EMPTY_COUNTS, ...(row.counts as IdentifyCounts) },
      error: row.error,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      finished_at: row.finishedAt?.toISOString() ?? null,
    };
  }

  private toItemDTO(row: IdentifyRunItem): IdentifyItemDTO {
    return {
      id: row.id,
      video_id: row.videoId,
      outcome: row.outcome,
      source: row.source,
      external_id: row.externalId,
      detail: row.detail,
      created_at: row.createdAt.toISOString(),
    };
  }
}

export const identifyService = new IdentifyService();
