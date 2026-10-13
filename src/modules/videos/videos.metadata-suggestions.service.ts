import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { visualSearchService, visualSearchStore } from "@/modules/visual-search/visual-search.service";
import { folderOf } from "./related-signals";
import {
  nameMatches,
  rankSuggestions,
  themeMatches,
  voteMatches,
  type Candidate,
  type CatalogEntity,
  type Suggestion,
  type SuggestionKind,
  type VoteGroup,
} from "./video-suggestions";
import { videosService } from "./videos.service";

export interface VideoMetadataSuggestions {
  creators: Suggestion[];
  tags: Suggestion[];
  studios: Suggestion[];
  /** Metadata proposals from a source match (ThePornDB, StashDB) waiting for review. */
  source_review: { pending: number };
  /** False until the video's frames are in the visual index; look-alike evidence is missing until then. */
  visual_index: boolean;
}

interface RelatedIds {
  id: number;
  file_path: string;
  creators: number[];
  tags: number[];
  studios: number[];
}

type Catalog = Record<SuggestionKind, CatalogEntity[]>;

const LIMITS: Record<SuggestionKind, number> = { creator: 6, tag: 10, studio: 3 };
const NEIGHBOURS = 16;
/** Look-alikes this far (cosine) under the best one stop counting as evidence. */
const NEIGHBOUR_BAND = 0.1;
const MIN_NEIGHBOUR_SCORE = 0.3;
/** Copies of the same file: whatever they carry very likely applies here too. */
const COPY_SCORE = 0.985;
/** Bigger folders are dumps, and their majority says little about one file. */
const MAX_FOLDER_SIBLINGS = 50;
const CATALOG_TTL_MS = 60_000;

function asIds(value: unknown): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  return String(value).replace(/[{}]/g, "").split(",").map((item) => Number(item.trim())).filter(Number.isFinite);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
}

export class VideoMetadataSuggestionsService {
  private catalogCache: { at: number; value: Promise<Catalog> } | null = null;

  async getSuggestions(userId: number, videoId: number): Promise<VideoMetadataSuggestions> {
    const video = await videosService.findById(videoId, userId) as unknown as {
      id: number;
      title: string | null;
      file_name: string;
      file_path: string;
      themes: string | null;
      creators?: { id: number }[];
      tags?: { id: number }[];
      studios?: { id: number }[];
    };
    const folder = folderOf(video.file_path);
    const [catalog, faces, neighbours, siblings, pending, indexed] = await Promise.all([
      this.catalog(),
      this.faceCandidates(videoId),
      visualSearchService.similarVideos(videoId, NEIGHBOURS).catch(() => []),
      this.folderSiblings(videoId, folder),
      this.pendingSourceProposals(videoId),
      visualSearchStore().indexed([videoId]).then((map) => map.has(videoId)).catch(() => false),
    ]);

    const copies = neighbours.filter((neighbour) => neighbour.score >= COPY_SCORE);
    const distinct = neighbours.filter((neighbour) => neighbour.score < COPY_SCORE);
    const top = distinct[0]?.score ?? 0;
    const lookAlikes = top < MIN_NEIGHBOUR_SCORE ? [] : distinct.filter((neighbour) => neighbour.score >= top - NEIGHBOUR_BAND);
    const relations = await this.relations([...copies, ...lookAlikes].map((neighbour) => neighbour.videoId));
    const weightOf = new Map(neighbours.map((neighbour) => [neighbour.videoId, neighbour.score]));

    const title = video.title?.trim() || stripExtension(video.file_name);
    const folderNames = folder.split(/[\\/]/).filter(Boolean).slice(-2).join(" ");

    const evidence = (kind: SuggestionKind, pick: (row: RelatedIds) => number[]): Candidate[] => {
      const list = catalog[kind];
      const out: Candidate[] = [...nameMatches(kind, title, list)];
      if (kind !== "tag" && folderNames) out.push(...nameMatches(kind, folderNames, list, "folder"));
      if (kind === "tag") out.push(...themeMatches(video.themes, list));
      for (const copy of copies) {
        const row = relations.get(copy.videoId);
        for (const id of row ? pick(row) : [])
          out.push({ id, reason: "copy", confidence: 0.9, detail: "Linked on a copy of this file" });
      }
      const similarGroups: VoteGroup[] = lookAlikes.map((neighbour) => ({
        weight: weightOf.get(neighbour.videoId) ?? 0,
        ids: relations.has(neighbour.videoId) ? pick(relations.get(neighbour.videoId)!) : [],
      }));
      out.push(...voteMatches(similarGroups, "similar", { minSupport: 2, minShare: 0.3, maxConfidence: 0.7, noun: "look-alike videos" }));
      const folderGroups: VoteGroup[] = siblings.map((row) => ({ weight: 1, ids: pick(row) }));
      if (folderGroups.length >= 2)
        out.push(...voteMatches(folderGroups, "folder", { minSupport: 2, minShare: 0.6, maxConfidence: 0.75, noun: "videos in its folder" }));
      return out;
    };

    const byId = (list: CatalogEntity[]) => new Map(list.map((entity) => [entity.id, entity]));
    const linked = (list?: { id: number }[]) => new Set((list ?? []).map((entity) => entity.id));
    return {
      creators: rankSuggestions([...faces, ...evidence("creator", (row) => row.creators)], byId(catalog.creator), linked(video.creators), LIMITS.creator),
      tags: rankSuggestions(evidence("tag", (row) => row.tags), byId(catalog.tag), linked(video.tags), LIMITS.tag),
      studios: rankSuggestions(evidence("studio", (row) => row.studios), byId(catalog.studio), linked(video.studios), LIMITS.studio),
      source_review: { pending },
      visual_index: indexed,
    };
  }

  /** Recognised faces: confirmed ones are certain, pending matches carry their similarity. */
  private async faceCandidates(videoId: number): Promise<Candidate[]> {
    try {
      const { getFaceRecognitionService } = await import("@/modules/face-recognition/face-recognition.service");
      const detections = await getFaceRecognitionService().getVideoFaceDetections(videoId);
      const byCreator = new Map<number, { count: number; best: number; confirmed: boolean }>();
      for (const detection of detections) {
        if (!detection.matchedCreatorId || detection.matchStatus === "rejected" || detection.matchStatus === "no_match") continue;
        const entry = byCreator.get(detection.matchedCreatorId) ?? { count: 0, best: 0, confirmed: false };
        entry.count += 1;
        entry.best = Math.max(entry.best, detection.matchConfidence ?? 0);
        entry.confirmed ||= detection.matchStatus === "confirmed";
        byCreator.set(detection.matchedCreatorId, entry);
      }
      return [...byCreator].map(([id, entry]) => ({
        id,
        reason: "face" as const,
        confidence: entry.confirmed ? 1 : Math.min(0.95, 0.4 + entry.best * 0.5 + Math.min(entry.count, 5) * 0.02),
        detail: entry.count === 1 ? "Face seen once" : `Face seen ${entry.count} times`,
      }));
    } catch {
      return [];
    }
  }

  private async pendingSourceProposals(videoId: number): Promise<number> {
    try {
      if (env.DEMO_MODE) {
        const { demoRepository } = await import("@/database/demo/repository");
        return demoRepository.getEnrichmentSuggestions({ entity_type: "scene", entity_id: videoId, status: "pending" }).length;
      }
      const [row] = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM enrichment_suggestions
        WHERE entity_type = 'scene' AND entity_id = ${videoId} AND status = 'pending'`);
      return Number(row?.count ?? 0);
    } catch {
      return 0;
    }
  }

  private async folderSiblings(videoId: number, folder: string): Promise<RelatedIds[]> {
    if (!folder) return [];
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const rows = (demoRepository.getVideos({ limit: 100_000, page: 1 }).data as any[])
        .filter((row) => row.id !== videoId && folderOf(row.file_path) === folder);
      return rows.length > MAX_FOLDER_SIBLINGS ? [] : rows.map(demoRelations);
    }
    const rows = await db.execute<{ id: number }>(sql`
      SELECT id FROM videos
      WHERE id <> ${videoId} AND is_available = true
        AND left(file_path, length(file_path) - length(file_name) - 1) = ${folder}
      LIMIT ${MAX_FOLDER_SIBLINGS + 1}`);
    if (rows.length > MAX_FOLDER_SIBLINGS) return [];
    return [...(await this.relations(rows.map((row) => Number(row.id)))).values()];
  }

  private async relations(ids: number[]): Promise<Map<number, RelatedIds>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      return new Map(unique.flatMap((id) => {
        try { return [[id, demoRelations(demoRepository.getVideoById(id))] as const]; } catch { return []; }
      }));
    }
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT v.id, v.file_path,
        (SELECT array_agg(creator_id) FROM video_creators WHERE video_id = v.id) AS creators,
        (SELECT array_agg(tag_id) FROM video_tags WHERE video_id = v.id) AS tags,
        (SELECT array_agg(studio_id) FROM video_studios WHERE video_id = v.id) AS studios
      FROM videos v WHERE v.id = ANY(${`{${unique.join(",")}}`}::int[])`);
    return new Map(rows.map((row) => [Number(row.id), {
      id: Number(row.id),
      file_path: String(row.file_path ?? ""),
      creators: asIds(row.creators),
      tags: asIds(row.tags),
      studios: asIds(row.studios),
    }]));
  }

  /** Every creator, studio and tag name (with aliases), cached briefly: titles are matched against all of them. */
  private catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.value;
    const value = this.loadCatalog();
    this.catalogCache = { at: Date.now(), value };
    value.catch(() => { this.catalogCache = null; });
    return value;
  }

  private async loadCatalog(): Promise<Catalog> {
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const creators = (demoRepository.getCreators({ limit: 100_000, page: 1 } as never).data as any[]).map((row) => ({
        id: row.id,
        name: row.name,
        aliases: demoRepository.getCreatorAliases(row.id).map((alias: { name: string }) => alias.name),
        profile_picture_url: row.profile_picture_url ?? (row.profile_picture_path ? `/api/creators/${row.id}/picture` : null),
      }));
      const studios = (demoRepository.getStudios({ limit: 100_000, page: 1 }).data as any[]).map((row) => ({
        id: row.id,
        name: row.name,
        profile_picture_url: row.profile_picture_path ? `/api/studios/${row.id}/picture` : null,
      }));
      const tags = (demoRepository.getTags() as any[]).map((row) => ({ id: row.id, name: row.name, color: row.color ?? null }));
      return { creator: creators, studio: studios, tag: tags };
    }
    const [creators, studios, tags] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        SELECT c.id, c.name, c.profile_picture_path, array_remove(array_agg(a.name), NULL) AS aliases
        FROM creators c LEFT JOIN creator_aliases a ON a.creator_id = c.id GROUP BY c.id`),
      db.execute<Record<string, unknown>>(sql`
        SELECT s.id, s.name, s.profile_picture_path, array_remove(array_agg(a.name), NULL) AS aliases
        FROM studios s LEFT JOIN studio_aliases a ON a.studio_id = s.id GROUP BY s.id`),
      db.execute<Record<string, unknown>>(sql`
        SELECT t.id, t.name, t.color, array_remove(array_agg(a.name), NULL) AS aliases
        FROM tags t LEFT JOIN tag_aliases a ON a.tag_id = t.id GROUP BY t.id`),
    ]);
    const aliases = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    return {
      creator: creators.map((row) => ({
        id: Number(row.id), name: String(row.name), aliases: aliases(row.aliases),
        profile_picture_url: row.profile_picture_path ? `/api/creators/${row.id}/picture` : null,
      })),
      studio: studios.map((row) => ({
        id: Number(row.id), name: String(row.name), aliases: aliases(row.aliases),
        profile_picture_url: row.profile_picture_path ? `/api/studios/${row.id}/picture` : null,
      })),
      tag: tags.map((row) => ({
        id: Number(row.id), name: String(row.name), aliases: aliases(row.aliases), color: (row.color as string | null) ?? null,
      })),
    };
  }
}

function demoRelations(row: any): RelatedIds {
  const ids = (list: { id: number }[] | undefined) => (list ?? []).map((entity) => entity.id);
  return { id: row.id, file_path: row.file_path ?? "", creators: ids(row.creators), tags: ids(row.tags), studios: ids(row.studios) };
}

export const videoMetadataSuggestionsService = new VideoMetadataSuggestionsService();
