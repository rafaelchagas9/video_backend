/**
 * Links Kura videos to the Stash scenes that hold the same files.
 *
 * Stash computes the fingerprints stash-box servers index (OSHASH, pHash)
 * and runs every stash-box lookup, so each Kura video needs its Stash scene.
 * Stash mounts the library read-only at the same absolute paths, so the link
 * is an exact path match. All Stash calls go through the enrichment service,
 * which holds the Stash API key.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  stashSceneLinksTable,
  videoFingerprintsTable,
  videosTable,
  watchedDirectoriesTable,
} from "@/database/schema";
import { getEnrichmentClient } from "@/modules/enrichment/enrichment.client";
import { computeVideoOshash } from "@/modules/enrichment/enrichment.fingerprint";
import { settingsService } from "@/modules/settings/settings.service";
import { AppError, BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";

export const STASH_SYNC_JOB_KIND = "stash.sync";
/** Paths per Stash scan / lookup request. */
const CHUNK = 50;
const JOB_POLL_MS = 2_000;

interface StashFileInfo {
  scene_id: string;
  file_id: string;
  duration: number | null;
  fingerprints: Record<string, string>;
  stash_ids: Array<{ endpoint: string; stash_id: string }>;
}

interface StashJob {
  id: string;
  status: string;
  progress?: number | null;
  error?: string | null;
}

export interface StashStatusDTO {
  configured: boolean;
  reachable: boolean;
  version?: string;
  error?: string;
  stash_boxes?: Array<{
    endpoint: string;
    name: string;
    provider_id: string | null;
  }>;
  library_paths?: string[];
  coverage: {
    videos: number;
    linked: number;
    with_phash: number;
    pre_conversion_hashes: number;
  };
}

export interface SyncProgress {
  stage: "scan" | "phash" | "link";
  done: number;
  total: number;
}

export interface SyncResult {
  total: number;
  linked: number;
  with_phash: number;
  missing: number[];
}

type Bridge = Pick<ReturnType<typeof getEnrichmentClient>, "request">;

export class StashLinkService {
  constructor(private readonly bridge: () => Bridge = getEnrichmentClient) {}

  private call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return this.bridge().request(path, method, body, 5 * 60_000) as Promise<T>;
  }

  async status(): Promise<StashStatusDTO> {
    const [counts] = await db
      .select({
        videos: sql<number>`count(*)::int`,
        linked: sql<number>`count(${stashSceneLinksTable.videoId})::int`,
        withPhash: sql<number>`count(*) FILTER (WHERE ${stashSceneLinksTable.hasPhash})::int`,
      })
      .from(videosTable)
      .leftJoin(
        stashSceneLinksTable,
        eq(stashSceneLinksTable.videoId, videosTable.id)
      )
      .where(eq(videosTable.isAvailable, true));
    const [original] = await db
      .select({ count: sql<number>`count(DISTINCT ${videoFingerprintsTable.videoId})::int` })
      .from(videoFingerprintsTable)
      .where(eq(videoFingerprintsTable.origin, "pre_conversion"));
    const coverage = {
      videos: counts?.videos ?? 0,
      linked: counts?.linked ?? 0,
      with_phash: counts?.withPhash ?? 0,
      pre_conversion_hashes: original?.count ?? 0,
    };
    try {
      const remote = await this.call<Omit<StashStatusDTO, "coverage">>(
        "/stash/status"
      );
      return { ...remote, coverage };
    } catch (error) {
      return {
        configured: false,
        reachable: false,
        error: error instanceof Error ? error.message : "Stash unavailable",
        coverage,
      };
    }
  }

  /** Videos whose current file has no Stash link, or whose link has no pHash. */
  async videosNeedingSync(
    { ids, limit = 100_000 }: { ids?: number[]; limit?: number } = {}
  ): Promise<number[]> {
    if (ids && ids.length === 0) return [];
    const rows = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .leftJoin(
        stashSceneLinksTable,
        eq(stashSceneLinksTable.videoId, videosTable.id)
      )
      .where(
        and(
          eq(videosTable.isAvailable, true),
          ids ? inArray(videosTable.id, ids) : undefined,
          sql`(${stashSceneLinksTable.videoId} IS NULL OR NOT ${stashSceneLinksTable.hasPhash} OR ${stashSceneLinksTable.filePath} <> ${videosTable.filePath})`
        )
      )
      .orderBy(videosTable.id)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Scan, fingerprint and link the given videos. Files Stash already knows
   * are only looked up; new ones are scanned (pHash only), and known scenes
   * missing a pHash get one generated.
   */
  async syncVideos(
    videoIds: number[],
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: SyncProgress) => Promise<void> | void;
    } = {}
  ): Promise<SyncResult> {
    const videos = videoIds.length
      ? await db
          .select({
            id: videosTable.id,
            filePath: videosTable.filePath,
          })
          .from(videosTable)
          .where(
            and(inArray(videosTable.id, videoIds), eq(videosTable.isAvailable, true))
          )
      : [];
    const result: SyncResult = {
      total: videos.length,
      linked: 0,
      with_phash: 0,
      missing: [],
    };
    if (videos.length === 0) return result;

    const roots = await db
      .select({ path: watchedDirectoriesTable.path })
      .from(watchedDirectoriesTable);
    await this.call("/stash/library/ensure", "POST", {
      paths: roots.map((root) => root.path),
    });

    for (let start = 0; start < videos.length; start += CHUNK) {
      options.signal?.throwIfAborted();
      const chunk = videos.slice(start, start + CHUNK);
      const paths = chunk.map((video) => video.filePath);
      let found = await this.lookup(paths);

      const unscanned = paths.filter((path) => !found[path]);
      if (unscanned.length > 0) {
        await options.onProgress?.({ stage: "scan", done: start, total: videos.length });
        await this.runJob(
          await this.call<{ job_id: string }>("/stash/scan", "POST", { paths: unscanned }),
          options.signal
        );
        found = { ...found, ...(await this.lookup(unscanned)) };
      }

      const withoutPhash = Object.values(found).filter(
        (file): file is StashFileInfo => Boolean(file && !file.fingerprints.phash)
      );
      if (withoutPhash.length > 0) {
        await options.onProgress?.({ stage: "phash", done: start, total: videos.length });
        await this.runJob(
          await this.call<{ job_id: string }>("/stash/phash", "POST", {
            scene_ids: [...new Set(withoutPhash.map((file) => file.scene_id))],
          }),
          options.signal
        );
        found = { ...found, ...(await this.lookup(paths.filter((path) => found[path] && !found[path]!.fingerprints.phash))) };
      }

      for (const video of chunk) {
        const file = found[video.filePath];
        if (!file) {
          result.missing.push(video.id);
          continue;
        }
        await this.storeLink(video.id, video.filePath, file);
        result.linked += 1;
        if (file.fingerprints.phash) result.with_phash += 1;
      }
      await options.onProgress?.({
        stage: "link",
        done: Math.min(start + CHUNK, videos.length),
        total: videos.length,
      });
    }
    return result;
  }

  private lookup(paths: string[]): Promise<Record<string, StashFileInfo | null>> {
    return this.call("/stash/scenes/lookup", "POST", { paths });
  }

  /** Wait for a Stash job; Stash runs its queue one job at a time. */
  private async runJob(
    { job_id }: { job_id: string },
    signal?: AbortSignal
  ): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const job = await this.call<StashJob>(`/stash/jobs/${encodeURIComponent(job_id)}`);
      if (job.status === "FINISHED") return;
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new AppError(502, `Stash job ${job_id} ${job.status.toLowerCase()}: ${job.error ?? "no detail"}`);
      }
      await Bun.sleep(JOB_POLL_MS);
    }
  }

  private async storeLink(
    videoId: number,
    filePath: string,
    file: StashFileInfo
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(stashSceneLinksTable)
        .values({
          videoId,
          stashSceneId: file.scene_id,
          stashFileId: file.file_id,
          filePath,
          hasPhash: Boolean(file.fingerprints.phash),
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: stashSceneLinksTable.videoId,
          set: {
            stashSceneId: file.scene_id,
            stashFileId: file.file_id,
            filePath,
            hasPhash: Boolean(file.fingerprints.phash),
            syncedAt: new Date(),
          },
        });
      const hashes = Object.entries(file.fingerprints)
        .map(([type, hash]) => ({ algorithm: type.toUpperCase(), hash: hash.toLowerCase() }))
        .filter((fp) => ["OSHASH", "MD5", "PHASH"].includes(fp.algorithm));
      // The current file's hashes replace the previous file's; originals stay.
      await tx
        .delete(videoFingerprintsTable)
        .where(
          and(
            eq(videoFingerprintsTable.videoId, videoId),
            eq(videoFingerprintsTable.origin, "stash"),
            ...(hashes.length
              ? [notInArray(videoFingerprintsTable.hash, hashes.map((fp) => fp.hash))]
              : [])
          )
        );
      if (hashes.length > 0) {
        await tx
          .insert(videoFingerprintsTable)
          .values(
            hashes.map((fp) => ({
              videoId,
              ...fp,
              origin: "stash",
              durationSeconds: file.duration,
              filePath,
            }))
          )
          .onConflictDoNothing();
      }
    });
  }

  /**
   * Keep the original file's OSHASH before a conversion replaces it: stash-box
   * servers index the released file, and after a re-encode only pHash matches.
   */
  async recordPreConversion(
    videoId: number,
    filePath: string,
    durationSeconds: number | null
  ): Promise<void> {
    if (env.DEMO_MODE) return;
    try {
      const hash = await computeVideoOshash(filePath);
      await db
        .insert(videoFingerprintsTable)
        .values({
          videoId,
          algorithm: "OSHASH",
          hash,
          origin: "pre_conversion",
          durationSeconds,
          filePath,
        })
        .onConflictDoNothing();
    } catch (error) {
      logger.warn({ videoId, error }, "Could not record the original file's OSHASH");
    }
  }

  /** Copy an accepted stash-box scene ID onto the linked Stash scene. */
  async recordStashId(videoId: number, source: string, externalId: string): Promise<void> {
    if (env.DEMO_MODE || source === "stash") return;
    const [link] = await db
      .select({ stashSceneId: stashSceneLinksTable.stashSceneId })
      .from(stashSceneLinksTable)
      .where(eq(stashSceneLinksTable.videoId, videoId))
      .limit(1);
    if (!link) return;
    try {
      await this.call(
        `/stash/scenes/${encodeURIComponent(link.stashSceneId)}/stash-ids`,
        "POST",
        { source, stash_id: externalId }
      );
    } catch (error) {
      logger.warn({ videoId, source, error }, "Could not record the stash ID in Stash");
    }
  }

  /**
   * Submit the linked files' fingerprints to a stash-box (StashDB, FansDB).
   * Only scenes whose accepted ID for that source is already in Stash count.
   */
  async submitFingerprints(
    videoIds: number[],
    source: string
  ): Promise<{ submitted: boolean; video_ids: number[]; skipped: number[] }> {
    const links = await db
      .select({
        videoId: stashSceneLinksTable.videoId,
        stashSceneId: stashSceneLinksTable.stashSceneId,
      })
      .from(stashSceneLinksTable)
      .where(inArray(stashSceneLinksTable.videoId, videoIds));
    const linked = new Set(links.map((link) => link.videoId));
    const skipped = videoIds.filter((id) => !linked.has(id));
    if (links.length === 0) {
      throw new BadRequestError(
        "None of these videos is linked to Stash yet; sync them with Stash first"
      );
    }
    const response = await this.call<{ submitted: boolean }>(
      "/stash/fingerprints/submit",
      "POST",
      {
        source,
        scene_ids: links.map((link) => link.stashSceneId),
        confirm: true,
      }
    );
    return {
      submitted: response.submitted,
      video_ids: links.map((link) => link.videoId),
      skipped,
    };
  }

  private pending = new Set<number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Sync new or converted files when enabled. A directory scan indexes files
   * one by one, so IDs gather until the scan has been quiet for a while and
   * then go to Stash as one job.
   */
  scheduleSync(videoIds: number[], quietMs = 30_000): void {
    if (env.DEMO_MODE || env.NODE_ENV === "test" || videoIds.length === 0) return;
    for (const id of videoIds) this.pending.add(id);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) =>
        logger.warn({ error }, "Could not queue the Stash sync")
      );
    }, quietMs);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length === 0) return;
    if ((await settingsService.getValue("stash_auto_sync")) === false) return;
    const { getStashRuntime } = await import("./stash.runtime");
    await getStashRuntime().enqueueSync({ video_ids: ids });
  }
}

export const stashLinkService = new StashLinkService();
