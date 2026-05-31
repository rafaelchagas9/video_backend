import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  favoritesTable,
  thumbnailsTable,
  tagsTable,
  videoRelatedScoresTable,
  videosTable,
} from "@/database/schema";
import { API_PREFIX } from "@/config/constants";
import type {
  RelatedVideosOptions,
  RelatedVideosResult,
  Video,
} from "./videos.types";
import { videosService } from "./videos.service";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 12;

interface RelatedFeatureRow {
  id: number;
  file_path: string;
  file_name: string;
  directory_id: number;
  file_size_bytes: number;
  file_hash: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  audio_codec: string | null;
  title: string | null;
  description: string | null;
  themes: string | null;
  is_available: boolean;
  last_verified_at: Date | string | null;
  indexed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  thumbnail_id: number | null;
  tag_ids: number[] | string | null;
  creator_ids: number[] | string | null;
  studio_ids: number[] | string | null;
  playlist_ids: number[] | string | null;
  play_count: number | string | null;
  last_played_at: Date | string | null;
  is_favorite: boolean | null;
  avg_rating: number | string | null;
}

interface ScoredCandidate {
  videoId: number;
  score: number;
  reasons: string[];
}

interface RelatedVideoRow {
  id: number;
  filePath: string;
  fileName: string;
  directoryId: number;
  fileSizeBytes: number;
  fileHash: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  audioCodec: string | null;
  title: string | null;
  description: string | null;
  themes: string | null;
  isAvailable: boolean;
  lastVerifiedAt: Date | string | null;
  indexedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  thumbnailId: number | null;
  isFavorite: boolean;
}

type TagFamilyMap = Map<number, Set<number>>;

export class VideosRelatedService {
  async getRelated(
    userId: number,
    sourceVideoId: number,
    options: RelatedVideosOptions = {},
  ): Promise<RelatedVideosResult> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
    await videosService.findById(sourceVideoId, userId);

    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const videosObj = demoMockService.getVideos({ limit: 100 });
      const sourceVideo = demoMockService.getVideoById(sourceVideoId) as Video;
      
      const candidates = (videosObj.data as Video[]).filter((v) => v.id !== sourceVideoId);
      
      const scored = candidates.map((v) => {
        let score = 0;
        const reasons: string[] = [];
        
        const sharedTags = v.tags ? v.tags.filter((t) => 
          sourceVideo.tags?.some((st) => st.name === t.name)
        ).length : 0;
        if (sharedTags > 0) {
          score += sharedTags * 18;
          reasons.push(`shared-tags:${sharedTags}`);
        }
        
        const sharedCreators = v.creators ? v.creators.filter((c) => 
          sourceVideo.creators?.some((sc) => sc.name === c.name)
        ).length : 0;
        if (sharedCreators > 0) {
          score += sharedCreators * 24;
          reasons.push(`shared-creators:${sharedCreators}`);
        }
        
        const sharedStudios = v.studios ? v.studios.filter((s) => 
          sourceVideo.studios?.some((ss) => ss.name === s.name)
        ).length : 0;
        if (sharedStudios > 0) {
          score += sharedStudios * 14;
          reasons.push(`shared-studios:${sharedStudios}`);
        }
        
        return {
          video: v,
          score,
          reasons
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
      
      return {
        data: scored,
        meta: {
          computed_at: new Date().toISOString(),
          refreshed: false,
          candidate_count: scored.length
        }
      };
    }

    let refreshed = false;
    const cacheState = await this.getCacheState(sourceVideoId);
    const isStale = cacheState.computedAt
      ? Date.now() - cacheState.computedAt.getTime() > CACHE_TTL_MS
      : true;

    if (options.refresh || isStale) {
      await this.refreshScores(userId, sourceVideoId);
      refreshed = true;
    }

    const rows = await db
      .select({
        sourceVideoId: videoRelatedScoresTable.sourceVideoId,
        relatedVideoId: videoRelatedScoresTable.relatedVideoId,
        score: videoRelatedScoresTable.score,
        reasonsJson: videoRelatedScoresTable.reasonsJson,
        computedAt: videoRelatedScoresTable.computedAt,
        id: videosTable.id,
        filePath: videosTable.filePath,
        fileName: videosTable.fileName,
        directoryId: videosTable.directoryId,
        fileSizeBytes: videosTable.fileSizeBytes,
        fileHash: videosTable.fileHash,
        durationSeconds: videosTable.durationSeconds,
        width: videosTable.width,
        height: videosTable.height,
        codec: videosTable.codec,
        bitrate: videosTable.bitrate,
        fps: videosTable.fps,
        audioCodec: videosTable.audioCodec,
        title: videosTable.title,
        description: videosTable.description,
        themes: videosTable.themes,
        isAvailable: videosTable.isAvailable,
        lastVerifiedAt: videosTable.lastVerifiedAt,
        indexedAt: videosTable.indexedAt,
        createdAt: videosTable.createdAt,
        updatedAt: videosTable.updatedAt,
        thumbnailId: thumbnailsTable.id,
        isFavorite: sql<boolean>`EXISTS (
          SELECT 1 FROM ${favoritesTable}
          WHERE ${favoritesTable.userId} = ${userId}
            AND ${favoritesTable.videoId} = ${videosTable.id}
        )`,
      })
      .from(videoRelatedScoresTable)
      .innerJoin(videosTable, eq(videoRelatedScoresTable.relatedVideoId, videosTable.id))
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .where(
        and(
          eq(videoRelatedScoresTable.sourceVideoId, sourceVideoId),
          eq(videosTable.isAvailable, true),
        ),
      )
      .orderBy(desc(videoRelatedScoresTable.score))
      .limit(limit);

    const latestComputedAt = rows[0]?.computedAt ?? cacheState.computedAt;

    return {
      data: rows.map((row) => ({
        video: this.mapVideo(row),
        score: Number(row.score),
        reasons: this.parseReasons(row.reasonsJson),
      })),
      meta: {
        computed_at: latestComputedAt ? this.toIsoString(latestComputedAt) : null,
        refreshed,
        candidate_count: refreshed
          ? await this.countCachedScores(sourceVideoId)
          : cacheState.count,
      },
    };
  }

  async refreshScores(userId: number, sourceVideoId: number): Promise<void> {
    const source = await this.getFeatureRow(userId, sourceVideoId);
    if (!source) {
      await videosService.findById(sourceVideoId, userId);
      return;
    }

    const candidates = await this.getCandidateFeatureRows(userId, sourceVideoId);
    const tagFamilyMap = await this.buildTagFamilyMap();
    const scored = candidates
      .map((candidate) => this.scoreCandidate(source, candidate, tagFamilyMap))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    await db
      .delete(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, sourceVideoId));

    if (scored.length > 0) {
      const computedAt = new Date();
      await db.insert(videoRelatedScoresTable).values(
        scored.map((candidate) => ({
          sourceVideoId,
          relatedVideoId: candidate.videoId,
          score: candidate.score,
          reasonsJson: JSON.stringify(candidate.reasons),
          computedAt,
        })),
      );
    }
  }

  private async getCacheState(
    sourceVideoId: number,
  ): Promise<{ computedAt: Date | null; count: number }> {
    const rows = await db
      .select({
        computedAt: sql<Date | null>`MAX(${videoRelatedScoresTable.computedAt})`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, sourceVideoId));

    return {
      computedAt: rows[0]?.computedAt ? new Date(rows[0].computedAt) : null,
      count: Number(rows[0]?.count ?? 0),
    };
  }

  private async countCachedScores(sourceVideoId: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, sourceVideoId));
    return Number(rows[0]?.count ?? 0);
  }

  private async getFeatureRow(
    userId: number,
    videoId: number,
  ): Promise<RelatedFeatureRow | null> {
    const rows = await this.getFeatureRows(userId, sql`v.id = ${videoId}`);
    return rows[0] ?? null;
  }

  private async getCandidateFeatureRows(
    userId: number,
    sourceVideoId: number,
  ): Promise<RelatedFeatureRow[]> {
    return this.getFeatureRows(
      userId,
      sql`v.id <> ${sourceVideoId} AND v.is_available = true`,
    );
  }

  private async getFeatureRows(
    userId: number,
    whereCondition: ReturnType<typeof sql>,
  ): Promise<RelatedFeatureRow[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT
        v.id,
        v.file_path,
        v.file_name,
        v.directory_id,
        v.file_size_bytes,
        v.file_hash,
        v.duration_seconds,
        v.width,
        v.height,
        v.codec,
        v.bitrate,
        v.fps,
        v.audio_codec,
        v.title,
        v.description,
        v.themes,
        v.is_available,
        v.last_verified_at,
        v.indexed_at,
        v.created_at,
        v.updated_at,
        t.id as thumbnail_id,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT vt.tag_id), NULL) as tag_ids,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT vc.creator_id), NULL) as creator_ids,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT vst.studio_id), NULL) as studio_ids,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT pv.playlist_id), NULL) as playlist_ids,
        COALESCE(vs.play_count, 0) as play_count,
        vs.last_played_at,
        EXISTS (
          SELECT 1 FROM favorites f
          WHERE f.user_id = ${userId} AND f.video_id = v.id
        ) as is_favorite,
        AVG(r.rating) as avg_rating
      FROM videos v
      LEFT JOIN (
        SELECT DISTINCT ON (video_id) id, video_id FROM thumbnails
      ) t ON t.video_id = v.id
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      LEFT JOIN video_creators vc ON vc.video_id = v.id
      LEFT JOIN video_studios vst ON vst.video_id = v.id
      LEFT JOIN playlist_videos pv ON pv.video_id = v.id
      LEFT JOIN video_stats vs ON vs.video_id = v.id AND vs.user_id = ${userId}
      LEFT JOIN ratings r ON r.video_id = v.id
      WHERE ${whereCondition}
      GROUP BY v.id, t.id, vs.play_count, vs.last_played_at
    `);

    return Array.isArray(rows) ? (rows as unknown as RelatedFeatureRow[]) : [];
  }

  private scoreCandidate(
    source: RelatedFeatureRow,
    candidate: RelatedFeatureRow,
    tagFamilyMap: TagFamilyMap,
  ): ScoredCandidate {
    const sourceTags = this.parseNumberArray(source.tag_ids);
    const candidateTags = this.parseNumberArray(candidate.tag_ids);
    const sourceTagFamily = this.expandTagFamily(sourceTags, tagFamilyMap);
    const candidateTagFamily = this.expandTagFamily(candidateTags, tagFamilyMap);
    const sourceCreators = this.parseNumberArray(source.creator_ids);
    const candidateCreators = this.parseNumberArray(candidate.creator_ids);
    const sourceStudios = this.parseNumberArray(source.studio_ids);
    const candidateStudios = this.parseNumberArray(candidate.studio_ids);
    const sourcePlaylists = this.parseNumberArray(source.playlist_ids);
    const candidatePlaylists = this.parseNumberArray(candidate.playlist_ids);
    const sourceThemes = this.parseThemes(source.themes);
    const candidateThemes = this.parseThemes(candidate.themes);

    const reasons: string[] = [];
    let score = 0;
    let strongRelevanceScore = 0;

    const sharedTags = this.intersection(sourceTags, candidateTags).length;
    if (sharedTags > 0) {
      const points = Math.min(72, sharedTags * 18);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`shared-tags:${sharedTags}`);
    }

    const sharedTagFamily = this.intersection(
      sourceTagFamily,
      candidateTagFamily,
    ).filter((tagId) => !sourceTags.includes(tagId) || !candidateTags.includes(tagId));
    if (sharedTagFamily.length > 0) {
      const points = Math.min(56, sharedTagFamily.length * 14);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`shared-tag-family:${sharedTagFamily.length}`);
    }

    const sharedThemes = this.intersection(sourceThemes, candidateThemes);
    if (sharedThemes.length > 0) {
      const points = Math.min(66, sharedThemes.length * 22);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`shared-themes:${sharedThemes.slice(0, 3).join(",")}`);
    }

    const sharedCreators = this.intersection(sourceCreators, candidateCreators).length;
    if (sharedCreators > 0) {
      const points = Math.min(48, sharedCreators * 24);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`shared-creators:${sharedCreators}`);
    }

    const sharedStudios = this.intersection(sourceStudios, candidateStudios).length;
    if (sharedStudios > 0) {
      const points = Math.min(28, sharedStudios * 14);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`shared-studios:${sharedStudios}`);
    }

    const sharedPlaylists = this.intersection(sourcePlaylists, candidatePlaylists).length;
    if (sharedPlaylists > 0) {
      const points = Math.min(40, sharedPlaylists * 20);
      score += points;
      strongRelevanceScore += points;
      reasons.push(`same-playlists:${sharedPlaylists}`);
    }

    if (strongRelevanceScore < 14) {
      return { videoId: candidate.id, score: 0, reasons: [] };
    }

    const durationScore = this.getDurationSimilarityScore(
      source.duration_seconds,
      candidate.duration_seconds,
    );
    if (durationScore > 0) {
      score += durationScore;
      reasons.push("similar-duration");
    }

    if (source.directory_id === candidate.directory_id) {
      score += 4;
      reasons.push("same-directory");
    }

    const avgRating = Number(candidate.avg_rating ?? 0);
    if (avgRating >= 4) {
      const points = Math.min(12, (avgRating - 3) * 6);
      score += points;
      reasons.push(`high-rating:${avgRating.toFixed(1)}`);
    }

    if (candidate.is_favorite) {
      score += 10;
      reasons.push("favorite");
    }

    const watchPenalty = this.getWatchPenalty(candidate);
    if (watchPenalty > 0) {
      score -= watchPenalty;
      reasons.push(`watched-penalty:-${watchPenalty}`);
    } else {
      score += 6;
      reasons.push("unwatched");
    }

    return {
      videoId: candidate.id,
      score: Math.max(0, Number(score.toFixed(2))),
      reasons,
    };
  }

  private getDurationSimilarityScore(
    sourceDuration: number | null,
    candidateDuration: number | null,
  ): number {
    if (!sourceDuration || !candidateDuration || sourceDuration <= 0) return 0;
    const ratio = Math.abs(sourceDuration - candidateDuration) / sourceDuration;
    if (ratio <= 0.1) return 8;
    if (ratio <= 0.25) return 5;
    if (ratio <= 0.5) return 2;
    return 0;
  }

  private getWatchPenalty(candidate: RelatedFeatureRow): number {
    const playCount = Number(candidate.play_count ?? 0);
    if (playCount <= 0) return 0;

    const lastPlayedAt = candidate.last_played_at
      ? new Date(candidate.last_played_at)
      : null;

    if (lastPlayedAt && !Number.isNaN(lastPlayedAt.getTime())) {
      const daysSinceLastPlayed =
        (Date.now() - lastPlayedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLastPlayed > 15) return 0;

      const recentPenalty = daysSinceLastPlayed <= 7 ? 35 : 22;
      return Math.min(95, Math.min(60, 28 + playCount * 8) + recentPenalty);
    }

    return Math.min(60, 28 + playCount * 8);
  }

  private async buildTagFamilyMap(): Promise<TagFamilyMap> {
    const tags = await db
      .select({ id: tagsTable.id, parentId: tagsTable.parentId })
      .from(tagsTable);

    const parentById = new Map<number, number | null>();
    const childrenByParent = new Map<number, number[]>();

    for (const tag of tags) {
      parentById.set(tag.id, tag.parentId);
      if (tag.parentId !== null) {
        const children = childrenByParent.get(tag.parentId) ?? [];
        children.push(tag.id);
        childrenByParent.set(tag.parentId, children);
      }
    }

    const familyMap: TagFamilyMap = new Map();
    for (const tag of tags) {
      const family = new Set<number>([tag.id]);

      let parentId = parentById.get(tag.id) ?? null;
      while (parentId !== null) {
        family.add(parentId);
        parentId = parentById.get(parentId) ?? null;
      }

      const stack = [...(childrenByParent.get(tag.id) ?? [])];
      while (stack.length > 0) {
        const childId = stack.pop()!;
        family.add(childId);
        stack.push(...(childrenByParent.get(childId) ?? []));
      }

      familyMap.set(tag.id, family);
    }

    return familyMap;
  }

  private expandTagFamily(tagIds: number[], tagFamilyMap: TagFamilyMap): number[] {
    const expanded = new Set<number>();
    for (const tagId of tagIds) {
      expanded.add(tagId);
      const family = tagFamilyMap.get(tagId);
      if (family) {
        for (const familyTagId of family) {
          expanded.add(familyTagId);
        }
      }
    }
    return Array.from(expanded);
  }

  private parseThemes(value: string | null): string[] {
    if (!value) return [];
    return Array.from(
      new Set(
        value
          .split(/[\n,;|]+/)
          .map((theme) => theme.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  private parseNumberArray(value: number[] | string | null): number[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
    return value
      .replace(/[{}]/g, "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter(Number.isFinite);
  }

  private intersection<T>(left: T[], right: T[]): T[] {
    const rightSet = new Set(right);
    return left.filter((item) => rightSet.has(item));
  }

  private parseReasons(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private mapVideo(row: RelatedVideoRow): Video {
    return {
      id: row.id,
      file_path: row.filePath,
      file_name: row.fileName,
      directory_id: row.directoryId,
      file_size_bytes: row.fileSizeBytes,
      file_hash: row.fileHash,
      duration_seconds: row.durationSeconds,
      width: row.width,
      height: row.height,
      codec: row.codec,
      bitrate: row.bitrate,
      fps: row.fps,
      audio_codec: row.audioCodec,
      title: row.title,
      description: row.description,
      themes: row.themes,
      is_available: row.isAvailable,
      last_verified_at: row.lastVerifiedAt
        ? this.toIsoString(row.lastVerifiedAt)
        : null,
      indexed_at: this.toIsoString(row.indexedAt),
      created_at: this.toIsoString(row.createdAt),
      updated_at: this.toIsoString(row.updatedAt),
      is_favorite: Boolean(row.isFavorite),
      thumbnail_id: row.thumbnailId,
      thumbnail_url: row.thumbnailId
        ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
        : null,
    };
  }

  private toIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}

export const videosRelatedService = new VideosRelatedService();
