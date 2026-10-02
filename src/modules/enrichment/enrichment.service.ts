/**
 * Enrichment Service
 *
 * Orchestrates enrichment across entity types (creator / studio / scene / tag):
 * calls the Python service for candidates, stores them as reviewable suggestions,
 * and (on explicit accept) writes them through the existing entity writers. Nothing
 * is ever auto-applied.
 */

import { computeVideoOshash } from "./enrichment.fingerprint";
import { loadEnrichmentImage } from "./enrichment.images";
import { createHash } from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  creatorsTable,
  creatorAliasesTable,
  creatorPlatformsTable,
  creatorExternalIdsTable,
  creatorMergesTable,
  studiosTable,
  studioAliasesTable,
  studioExternalIdsTable,
  tagsTable,
  tagAliasesTable,
  tagExternalIdsTable,
  tagCategoriesTable,
  videosTable,
  videoMetadataTable,
  videoCreatorsTable,
  videoTagsTable,
  videoExternalIdsTable,
  enrichmentSuggestionsTable,
  enrichmentRunsTable,
  type EnrichmentSuggestion,
  type EnrichmentRun,
  type EnrichmentEntityType,
  type NewCreator,
} from "@/database/schema";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "@/utils/errors";
import { env } from "@/config/env";
import { studioAssignmentService } from "@/modules/studios/studio-assignment.service";
import { logger } from "@/utils/logger";
import { creatorsService } from "@/modules/creators/creators.service";
import { creatorsSocialService } from "@/modules/creators/creators.social.service";
import { creatorsAliasesService } from "@/modules/creators/creators.aliases.service";
import { creatorsPlatformsService } from "@/modules/creators/creators.platforms.service";
import { studiosService } from "@/modules/studios/studios.service";
import { studiosSocialService } from "@/modules/studios/studios.social.service";
import { tagsService } from "@/modules/tags/tags.service";
import { platformsService } from "@/modules/platforms/platforms.service";
import { getEnrichmentClient } from "./enrichment.client";
import { enrichmentDemoService } from "./enrichment.demo.service";
import { imageSizeProbe } from "./enrichment.image-sizes";
import { parseExactExternalReference } from "./enrichment.reference";
import type {
  Candidate,
  EnrichRequest,
  EntityType,
  RelationalRaw,
  RunEnrichmentOptions,
  RunDTO,
  SceneResetDTO,
  SuggestionDTO,
} from "./enrichment.types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const AUTO_ACCEPT_RELATED_TYPES: Record<
  Exclude<EnrichmentEntityType, "scene">,
  Set<string>
> = {
  creator: new Set([
    "image",
    "platform",
    "social",
    "bio",
    "alias",
    "field",
    "external_id",
  ]),
  studio: new Set(["image", "social", "alias", "field", "external_id"]),
  tag: new Set(["field", "alias", "external_id", "category"]),
};

/**
 * Whitelist mapping a creator candidate `field_key` (snake_case DB column) to the
 * Drizzle `.set()` partial. Keeps accepted `field` suggestions to known, safe columns.
 */
const CREATOR_FIELD_SETTERS: Record<
  string,
  (value: string) => Partial<NewCreator>
> = {
  gender: (v) => ({ gender: v }),
  birth_date: (v) => ({ birthDate: v }),
  death_date: (v) => ({ deathDate: v }),
  ethnicity: (v) => ({ ethnicity: v }),
  country: (v) => ({ country: v }),
  birthplace: (v) => ({ birthplace: v }),
  eye_color: (v) => ({ eyeColor: v }),
  hair_color: (v) => ({ hairColor: v }),
  cup_size: (v) => ({ cupSize: v }),
  breast_type: (v) => ({ breastType: v }),
  height_cm: (v) => ({ heightCm: toInt(v, "height_cm") }),
  band_size: (v) => ({ bandSize: toInt(v, "band_size") }),
  waist_size: (v) => ({ waistSize: toInt(v, "waist_size") }),
  hip_size: (v) => ({ hipSize: toInt(v, "hip_size") }),
  career_start_year: (v) => ({
    careerStartYear: toInt(v, "career_start_year"),
  }),
  career_end_year: (v) => ({ careerEndYear: toInt(v, "career_end_year") }),
};

/** Scene `field` keys that are stored in `video_metadata` (key/value). */
const SCENE_METADATA_FIELDS = new Set(["release_date", "code", "director"]);

function toInt(value: string, field: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new BadRequestError(`Invalid integer for ${field}: ${value}`);
  }
  return n;
}

export type RelatedKind = "creator" | "studio" | "tag";

export interface RelatedMatch {
  id: number;
  name: string;
  via: "external_id" | "name" | "alias";
  /** Tags only: how the library shows it. */
  color?: string | null;
  category?: string | null;
}

export interface ResolutionPreview {
  suggestion_id: number;
  kind: RelatedKind;
  match: RelatedMatch | null;
}

const RELATED_KIND_BY_TYPE: Record<string, RelatedKind> = {
  performer: "creator",
  studio: "studio",
  tag: "tag",
};

const RELATED_TABLES = {
  creator: {
    table: creatorsTable,
    id: creatorsTable.id,
    name: creatorsTable.name,
    ext: creatorExternalIdsTable,
    extOwner: creatorExternalIdsTable.creatorId,
    extSource: creatorExternalIdsTable.source,
    extId: creatorExternalIdsTable.externalId,
    alias: creatorAliasesTable,
    aliasOwner: creatorAliasesTable.creatorId,
    aliasName: creatorAliasesTable.name,
  },
  studio: {
    table: studiosTable,
    id: studiosTable.id,
    name: studiosTable.name,
    ext: studioExternalIdsTable,
    extOwner: studioExternalIdsTable.studioId,
    extSource: studioExternalIdsTable.source,
    extId: studioExternalIdsTable.externalId,
    alias: studioAliasesTable,
    aliasOwner: studioAliasesTable.studioId,
    aliasName: studioAliasesTable.name,
  },
  tag: {
    table: tagsTable,
    id: tagsTable.id,
    name: tagsTable.name,
    ext: tagExternalIdsTable,
    extOwner: tagExternalIdsTable.tagId,
    extSource: tagExternalIdsTable.source,
    extId: tagExternalIdsTable.externalId,
    alias: tagAliasesTable,
    aliasOwner: tagAliasesTable.tagId,
    aliasName: tagAliasesTable.name,
  },
} as const;

/** Image accepts download from the source, so a pass runs this many at once. */
const RESOLVE_IMAGE_CONCURRENCY = 4;

export interface ResolveResult {
  accepted: number[];
  rejected: number[];
  failed: Array<{ id: number; message: string }>;
}

export interface ListSuggestionsFilters {
  entity_type?: EntityType;
  entity_id?: number;
  status?: string;
  type?: string;
}

export class EnrichmentService {
  /**
   * Run discovery for an entity: gather identity inputs, call the Python service,
   * and persist the returned candidates as pending suggestions (deduped).
   */
  async runEnrichment(
    entityType: EntityType,
    entityId: number,
    options: RunEnrichmentOptions = {}
  ): Promise<RunDTO> {
    // In demo mode the seeded proposals are the whole universe: a scan logs a
    // run and reports what is still awaiting a decision, without reaching the
    // external enrichment service or the database.
    if (env.DEMO_MODE) {
      return enrichmentDemoService.runEnrichment(entityType, entityId, options);
    }

    if (
      (options.identify_by_hash ||
        options.fingerprint ||
        options.stash_scene_id) &&
      entityType !== "scene"
    ) {
      throw new BadRequestError(
        "Fingerprints identify videos; use a creator profile URL for creator metadata"
      );
    }
    const request = await this.gatherInputs(entityType, entityId, options);

    const [run] = await db
      .insert(enrichmentRunsTable)
      .values({ entityType, entityId, status: "running" })
      .returning();

    let result;
    try {
      result = await getEnrichmentClient().enrich(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(enrichmentRunsTable)
        .set({ status: "error", errors: [message], finishedAt: new Date() })
        .where(eq(enrichmentRunsTable.id, run.id));
      logger.error({ entityType, entityId, error }, "Enrichment run failed");
      throw new AppError(502, `Enrichment service error: ${message}`);
    }

    // A creator can be merged while the remote enrichment call is in flight.
    // Lock the live/canonical creator while persisting so merge either moves
    // these rows afterward or we resolve the already-completed merge first.
    const persisted = await db.transaction(async (tx) => {
      const canonicalEntityId = await this.lockCanonicalCreatorForWrite(
        tx,
        entityType,
        entityId
      );
      let inserted = 0;
      let images: number[] = [];
      if (result.candidates.length > 0) {
        const rows = result.candidates.map((candidate) =>
          this.toSuggestionRow(entityType, canonicalEntityId, candidate)
        );
        const insertedRows = await tx
          .insert(enrichmentSuggestionsTable)
          .values(rows)
          .onConflictDoNothing()
          .returning({
            id: enrichmentSuggestionsTable.id,
            type: enrichmentSuggestionsTable.type,
          });
        inserted = insertedRows.length;
        images = insertedRows
          .filter((row) => row.type === "image")
          .map((row) => row.id);
      }

      const [updated] = await tx
        .update(enrichmentRunsTable)
        .set({
          entityId: canonicalEntityId,
          status:
            result.errors.length > 0 && result.sources_used.length === 0
              ? "error"
              : "success",
          sourcesUsed: result.sources_used,
          suggestionCount: inserted,
          errors: result.errors.length > 0 ? result.errors : null,
          finishedAt: new Date(),
        })
        .where(eq(enrichmentRunsTable.id, run.id))
        .returning();
      return { canonicalEntityId, inserted, updated, images };
    });
    imageSizeProbe.measure(persisted.images);

    logger.info(
      {
        entityType,
        entityId: persisted.canonicalEntityId,
        runId: run.id,
        candidates: result.candidates.length,
        inserted: persisted.inserted,
        sources: result.sources_used,
      },
      "Enrichment run complete"
    );

    return this.toRunDTO(persisted.updated);
  }

  private async lockCanonicalCreatorForWrite(
    tx: Tx,
    entityType: EntityType,
    entityId: number
  ): Promise<number> {
    if (entityType !== "creator") return entityId;

    let candidateId = entityId;
    for (let depth = 0; depth < 20; depth += 1) {
      const [creator] = await tx
        .select({ id: creatorsTable.id })
        .from(creatorsTable)
        .where(eq(creatorsTable.id, candidateId))
        .limit(1)
        .for("share");
      if (creator) return creator.id;

      const [merge] = await tx
        .select({ intoCreatorId: creatorMergesTable.intoCreatorId })
        .from(creatorMergesTable)
        .where(eq(creatorMergesTable.fromCreatorId, candidateId))
        .orderBy(desc(creatorMergesTable.id))
        .limit(1);
      if (!merge) {
        throw new NotFoundError(`Creator not found with id: ${entityId}`);
      }
      candidateId = merge.intoCreatorId;
    }

    throw new ConflictError(
      `Creator merge chain is too deep for creator ${entityId}`
    );
  }

  /** Build the discovery request for the Python service, per entity type. */
  private async gatherInputs(
    entityType: EntityType,
    entityId: number,
    options: RunEnrichmentOptions = {}
  ): Promise<EnrichRequest> {
    const exactReference = options.external_ref
      ? parseExactExternalReference(
          options.external_ref,
          entityType,
          options.sources
        )
      : null;
    const applyRunOptions = (request: EnrichRequest): EnrichRequest => ({
      ...request,
      name: options.search_name ?? request.name,
      ...(options.search_name !== undefined
        ? { title: options.search_name }
        : {}),
      ...(exactReference
        ? {
            sources: [exactReference.source],
            external_ids: [
              {
                source: exactReference.source,
                external_id: exactReference.externalId,
              },
            ],
          }
        : options.sources !== undefined
          ? { sources: options.sources }
          : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.scraper_url
        ? {
            scraper_url: options.scraper_url,
            sources: options.sources ?? ["stash"],
          }
        : {}),
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options.stash_scene_id
        ? { stash_scene_id: options.stash_scene_id }
        : {}),
    });

    switch (entityType) {
      case "creator": {
        const [creator] = await db
          .select()
          .from(creatorsTable)
          .where(eq(creatorsTable.id, entityId))
          .limit(1);
        if (!creator) {
          throw new NotFoundError(`Creator not found with id: ${entityId}`);
        }
        const aliasRows = await db
          .select({ name: creatorAliasesTable.name })
          .from(creatorAliasesTable)
          .where(eq(creatorAliasesTable.creatorId, entityId));
        const handleRows = await db
          .select({ username: creatorPlatformsTable.username })
          .from(creatorPlatformsTable)
          .where(eq(creatorPlatformsTable.creatorId, entityId));
        const externalIds = options.search_name
          ? []
          : await db
              .select({
                source: creatorExternalIdsTable.source,
                external_id: creatorExternalIdsTable.externalId,
              })
              .from(creatorExternalIdsTable)
              .where(eq(creatorExternalIdsTable.creatorId, entityId));
        return applyRunOptions({
          entity_type: "creator",
          external_ids: externalIds,
          name: creator.name,
          aliases: aliasRows.map((a) => a.name),
          handles: handleRows.map((h) => h.username),
        });
      }
      case "studio": {
        const [studio] = await db
          .select()
          .from(studiosTable)
          .where(eq(studiosTable.id, entityId))
          .limit(1);
        if (!studio) {
          throw new NotFoundError(`Studio not found with id: ${entityId}`);
        }
        const aliasRows = await db
          .select({ name: studioAliasesTable.name })
          .from(studioAliasesTable)
          .where(eq(studioAliasesTable.studioId, entityId));
        const externalIds = options.search_name
          ? []
          : await db
              .select({
                source: studioExternalIdsTable.source,
                external_id: studioExternalIdsTable.externalId,
              })
              .from(studioExternalIdsTable)
              .where(eq(studioExternalIdsTable.studioId, entityId));
        return applyRunOptions({
          entity_type: "studio",
          external_ids: externalIds,
          name: studio.name,
          aliases: aliasRows.map((a) => a.name),
          handles: [],
        });
      }
      case "tag": {
        const [tag] = await db
          .select()
          .from(tagsTable)
          .where(eq(tagsTable.id, entityId))
          .limit(1);
        if (!tag) {
          throw new NotFoundError(`Tag not found with id: ${entityId}`);
        }
        const aliasRows = await db
          .select({ name: tagAliasesTable.name })
          .from(tagAliasesTable)
          .where(eq(tagAliasesTable.tagId, entityId));
        const externalIds = options.search_name
          ? []
          : await db
              .select({
                source: tagExternalIdsTable.source,
                external_id: tagExternalIdsTable.externalId,
              })
              .from(tagExternalIdsTable)
              .where(eq(tagExternalIdsTable.tagId, entityId));
        return applyRunOptions({
          entity_type: "tag",
          external_ids: externalIds,
          name: tag.name,
          aliases: aliasRows.map((a) => a.name),
          handles: [],
        });
      }
      case "scene": {
        const [video] = await db
          .select()
          .from(videosTable)
          .where(eq(videosTable.id, entityId))
          .limit(1);
        if (!video) {
          throw new NotFoundError(`Video not found with id: ${entityId}`);
        }
        const externalIds = options.search_name
          ? []
          : await db
              .select({
                source: videoExternalIdsTable.source,
                external_id: videoExternalIdsTable.externalId,
              })
              .from(videoExternalIdsTable)
              .where(eq(videoExternalIdsTable.videoId, entityId));
        return applyRunOptions({
          entity_type: "scene",
          external_ids: externalIds,
          ...(options.identify_by_hash
            ? {
                fingerprint: {
                  algorithm: "OSHASH" as const,
                  hash: await computeVideoOshash(video.filePath),
                  duration: video.durationSeconds ?? undefined,
                },
              }
            : {}),
          name: video.title || video.fileName,
          title: video.title,
          file_name: video.fileName,
          duration_seconds: video.durationSeconds,
          aliases: [],
          handles: [],
        });
      }
      default:
        throw new BadRequestError(`Unsupported entity type: ${entityType}`);
    }
  }

  async listSuggestions(
    filters: ListSuggestionsFilters
  ): Promise<SuggestionDTO[]> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.listSuggestions(filters);
    }

    const conditions = [];
    if (filters.entity_type) {
      conditions.push(
        eq(enrichmentSuggestionsTable.entityType, filters.entity_type)
      );
    }
    if (filters.entity_id !== undefined) {
      conditions.push(
        eq(enrichmentSuggestionsTable.entityId, filters.entity_id)
      );
    }
    if (filters.status) {
      conditions.push(eq(enrichmentSuggestionsTable.status, filters.status));
    }
    if (filters.type) {
      conditions.push(eq(enrichmentSuggestionsTable.type, filters.type));
    }

    const rows = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        desc(sql`coalesce(${enrichmentSuggestionsTable.faceMatchScore}, 0)`),
        desc(sql`coalesce(${enrichmentSuggestionsTable.confidence}, 0)`),
        enrichmentSuggestionsTable.id
      );

    // Pictures from before sizes were recorded get measured in the background.
    imageSizeProbe.measure(
      rows
        .filter(
          (row) =>
            row.type === "image" &&
            row.status === "pending" &&
            row.imageWidth === null
        )
        .map((row) => row.id)
    );
    return rows.map((r) => this.toSuggestionDTO(r));
  }

  async listRuns(entityType: EntityType, entityId: number): Promise<RunDTO[]> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.listRuns(entityType, entityId);
    }

    const rows = await db
      .select()
      .from(enrichmentRunsTable)
      .where(
        and(
          eq(enrichmentRunsTable.entityType, entityType),
          eq(enrichmentRunsTable.entityId, entityId)
        )
      )
      .orderBy(desc(enrichmentRunsTable.startedAt));
    return rows.map((r) => this.toRunDTO(r));
  }

  /**
   * Accept a pending suggestion: write it through the existing entity writers,
   * then mark it accepted.
   */
  async acceptSuggestion(id: number): Promise<SuggestionDTO> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.acceptSuggestion(id);
    }

    const suggestion = await this.getSuggestionOrThrow(id);
    if (suggestion.status !== "pending") {
      throw new BadRequestError(
        `Suggestion ${id} is not pending (status: ${suggestion.status})`
      );
    }

    switch (suggestion.entityType as EnrichmentEntityType) {
      case "creator":
        await this.applyCreator(suggestion);
        break;
      case "studio":
        await this.applyStudio(suggestion);
        break;
      case "scene":
        await this.applyScene(suggestion);
        break;
      case "tag":
        await this.applyTag(suggestion);
        break;
      default:
        throw new BadRequestError(
          `Unsupported entity type: ${suggestion.entityType}`
        );
    }

    const [updated] = await db
      .update(enrichmentSuggestionsTable)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(eq(enrichmentSuggestionsTable.id, id))
      .returning();

    logger.info(
      {
        suggestionId: id,
        entityType: suggestion.entityType,
        entityId: suggestion.entityId,
        type: suggestion.type,
      },
      "Accepted enrichment suggestion"
    );

    return this.toSuggestionDTO(updated);
  }

  /**
   * Resolve a review pass. Rejects land in one statement; accepts go through
   * `acceptSuggestion` so each one uses the same writers as a single accept.
   * Images download, so they run a few at a time; everything else runs in order
   * because fields and aliases write the same creator row.
   */
  async resolveSuggestions(body: {
    accept: number[];
    reject: number[];
  }): Promise<ResolveResult> {
    const result: ResolveResult = { accepted: [], rejected: [], failed: [] };

    if (body.reject.length > 0) {
      if (env.DEMO_MODE) {
        for (const id of body.reject) {
          await this.settle(result, id, async () => {
            await enrichmentDemoService.rejectSuggestion(id);
            result.rejected.push(id);
          });
        }
      } else {
        const rows = await db
          .update(enrichmentSuggestionsTable)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(
            and(
              inArray(enrichmentSuggestionsTable.id, body.reject),
              eq(enrichmentSuggestionsTable.status, "pending")
            )
          )
          .returning({ id: enrichmentSuggestionsTable.id });
        const done = new Set(rows.map((row) => row.id));
        for (const id of body.reject) {
          if (done.has(id)) result.rejected.push(id);
          else result.failed.push({ id, message: "Not pending" });
        }
      }
    }

    // Demo suggestions live in SQLite, so every demo accept takes the ordered path.
    const types = new Map<number, string>();
    if (!env.DEMO_MODE && body.accept.length > 0) {
      const rows = await db
        .select({
          id: enrichmentSuggestionsTable.id,
          type: enrichmentSuggestionsTable.type,
        })
        .from(enrichmentSuggestionsTable)
        .where(inArray(enrichmentSuggestionsTable.id, body.accept));
      for (const row of rows) types.set(row.id, row.type);
    }
    const accept = async (id: number) =>
      this.settle(result, id, async () => {
        await this.acceptSuggestion(id);
        result.accepted.push(id);
      });

    for (const id of body.accept.filter((id) => types.get(id) !== "image")) {
      await accept(id);
    }
    const images = body.accept.filter((id) => types.get(id) === "image");
    for (
      let index = 0;
      index < images.length;
      index += RESOLVE_IMAGE_CONCURRENCY
    ) {
      await Promise.all(
        images.slice(index, index + RESOLVE_IMAGE_CONCURRENCY).map(accept)
      );
    }

    logger.info(
      {
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        failed: result.failed.length,
      },
      "Resolved enrichment suggestions"
    );
    return result;
  }

  private async settle(
    result: ResolveResult,
    id: number,
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      result.failed.push({
        id,
        message: error instanceof Error ? error.message : "Failed",
      });
    }
  }

  async rejectSuggestion(id: number): Promise<SuggestionDTO> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.rejectSuggestion(id);
    }

    await this.getSuggestionOrThrow(id);
    const [updated] = await db
      .update(enrichmentSuggestionsTable)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(enrichmentSuggestionsTable.id, id))
      .returning();
    return this.toSuggestionDTO(updated);
  }

  /**
   * Remove all suggestions and runs for an entity. Called from each entity's delete
   * path since `entity_id` is not a foreign key (polymorphic table, no DB cascade).
   */
  async deleteForEntity(
    entityType: EnrichmentEntityType,
    entityId: number
  ): Promise<void> {
    await db
      .delete(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, entityType),
          eq(enrichmentSuggestionsTable.entityId, entityId)
        )
      );
    await db
      .delete(enrichmentRunsTable)
      .where(
        and(
          eq(enrichmentRunsTable.entityType, entityType),
          eq(enrichmentRunsTable.entityId, entityId)
        )
      );
  }

  /**
   * Undo a scene's enrichment. Only what accepted proposals wrote is removed, and a
   * field only when it still holds the value that was applied (a later manual edit
   * stays). Every proposal and run is then deleted, because a rescan skips decided
   * proposals and would otherwise never offer the right match again.
   */
  async resetScene(videoId: number): Promise<SceneResetDTO> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.resetScene(videoId);
    }

    const [video] = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        description: videosTable.description,
      })
      .from(videosTable)
      .where(eq(videosTable.id, videoId))
      .limit(1);
    if (!video) throw new NotFoundError(`Video not found: ${videoId}`);

    const accepted = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, "scene"),
          eq(enrichmentSuggestionsTable.entityId, videoId),
          eq(enrichmentSuggestionsTable.status, "accepted")
        )
      );

    const fieldsCleared = new Set<string>();
    let linksRemoved = 0;
    const clearMetadata = async (key: string, value: string) => {
      const rows = await db
        .delete(videoMetadataTable)
        .where(
          and(
            eq(videoMetadataTable.videoId, videoId),
            eq(videoMetadataTable.key, key),
            eq(videoMetadataTable.value, value)
          )
        )
        .returning({ id: videoMetadataTable.id });
      if (rows.length > 0) fieldsCleared.add(key);
    };

    for (const s of accepted) {
      switch (s.type) {
        case "field": {
          const key = s.fieldKey ?? "";
          if (key === "title" && video.title === s.value) {
            await db
              .update(videosTable)
              .set({ title: null, updatedAt: new Date() })
              .where(eq(videosTable.id, videoId));
            video.title = null;
            fieldsCleared.add("title");
          } else if (key === "description" && video.description === s.value) {
            await db
              .update(videosTable)
              .set({ description: null, updatedAt: new Date() })
              .where(eq(videosTable.id, videoId));
            video.description = null;
            fieldsCleared.add("description");
          } else if (SCENE_METADATA_FIELDS.has(key)) {
            await clearMetadata(key, s.value);
          }
          break;
        }
        case "image":
          await clearMetadata("cover_image_url", s.value);
          break;
        case "external_id": {
          const rows = await db
            .delete(videoExternalIdsTable)
            .where(
              and(
                eq(videoExternalIdsTable.videoId, videoId),
                eq(videoExternalIdsTable.source, s.source),
                eq(videoExternalIdsTable.externalId, s.value)
              )
            )
            .returning({ id: videoExternalIdsTable.id });
          linksRemoved += rows.length;
          break;
        }
        case "performer":
        case "studio":
        case "tag": {
          const kind = RELATED_KIND_BY_TYPE[s.type];
          if (!kind) break;
          const raw = this.parseRaw(s);
          const match = await this.findRelatedEntity(
            kind,
            s.value,
            raw.source ?? s.source,
            raw.external_id
          );
          if (!match) break;
          if (kind === "creator") {
            const rows = await db
              .delete(videoCreatorsTable)
              .where(
                and(
                  eq(videoCreatorsTable.videoId, videoId),
                  eq(videoCreatorsTable.creatorId, match.id)
                )
              )
              .returning({ videoId: videoCreatorsTable.videoId });
            linksRemoved += rows.length;
          } else if (kind === "tag") {
            const rows = await db
              .delete(videoTagsTable)
              .where(
                and(
                  eq(videoTagsTable.videoId, videoId),
                  eq(videoTagsTable.tagId, match.id)
                )
              )
              .returning({ videoId: videoTagsTable.videoId });
            linksRemoved += rows.length;
          } else {
            linksRemoved += await studioAssignmentService.unlinkMany(
              [videoId],
              [match.id]
            );
          }
          break;
        }
      }
    }

    const cleared = await db
      .delete(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, "scene"),
          eq(enrichmentSuggestionsTable.entityId, videoId)
        )
      )
      .returning({ id: enrichmentSuggestionsTable.id });
    await db
      .delete(enrichmentRunsTable)
      .where(
        and(
          eq(enrichmentRunsTable.entityType, "scene"),
          eq(enrichmentRunsTable.entityId, videoId)
        )
      );

    logger.info(
      {
        videoId,
        suggestions: cleared.length,
        fields: [...fieldsCleared],
        links: linksRemoved,
      },
      "Reset scene enrichment"
    );
    return {
      suggestions_cleared: cleared.length,
      fields_cleared: [...fieldsCleared],
      links_removed: linksRemoved,
    };
  }

  // --- Apply: creator -----------------------------------------------------

  private async applyCreator(s: EnrichmentSuggestion): Promise<void> {
    const creatorId = s.entityId;
    switch (s.type) {
      case "image":
        await creatorsSocialService.addGalleryMedia(
          creatorId,
          await loadEnrichmentImage(s.value),
          `From ${s.source}`
        );
        break;
      case "social":
        await creatorsSocialService.addSocialLink(creatorId, {
          platform_name: (s.fieldKey || s.source).slice(0, 50),
          url: s.value,
        });
        break;
      case "alias":
        await creatorsAliasesService.addAlias(creatorId, {
          name: s.value.slice(0, 255),
        });
        break;
      case "platform": {
        const platformName = (s.fieldKey || s.source).slice(0, 100);
        const platform =
          (await platformsService.findByName(platformName)) ??
          (await platformsService.create({ name: platformName }));
        await creatorsPlatformsService.addPlatformProfile(creatorId, {
          platform_id: platform.id,
          username: deriveUsername(s.value),
          profile_url: s.value,
          is_primary: false,
        });
        break;
      }
      case "bio":
        await db
          .update(creatorsTable)
          .set({ description: s.value, updatedAt: new Date() })
          .where(eq(creatorsTable.id, creatorId));
        break;
      case "field": {
        const setter = CREATOR_FIELD_SETTERS[s.fieldKey ?? ""];
        if (!setter) {
          throw new BadRequestError(`Unsupported field key: ${s.fieldKey}`);
        }
        await db
          .update(creatorsTable)
          .set({ ...setter(s.value), updatedAt: new Date() })
          .where(eq(creatorsTable.id, creatorId));
        break;
      }
      case "external_id":
        await db
          .insert(creatorExternalIdsTable)
          .values({
            creatorId,
            source: s.source,
            externalId: s.value,
            externalUrl: s.sourceUrl ?? null,
            lastSyncedAt: new Date(),
          })
          .onConflictDoNothing();
        break;
      default:
        throw new BadRequestError(
          `Unsupported creator suggestion type: ${s.type}`
        );
    }
  }

  // --- Apply: studio ------------------------------------------------------

  private async applyStudio(s: EnrichmentSuggestion): Promise<void> {
    const studioId = s.entityId;
    switch (s.type) {
      case "image":
        await studiosSocialService.setPictureFromUrl(studioId, s.value);
        break;
      case "social":
        await studiosSocialService.addSocialLink(studioId, {
          platform_name: (s.fieldKey || s.source).slice(0, 50),
          url: s.value,
        });
        break;
      case "alias":
        await db
          .insert(studioAliasesTable)
          .values({ studioId, name: s.value.slice(0, 255) })
          .onConflictDoNothing();
        break;
      case "field":
        if (s.fieldKey === "description") {
          await studiosService.update(studioId, { description: s.value });
        } else {
          throw new BadRequestError(`Unsupported studio field: ${s.fieldKey}`);
        }
        break;
      case "external_id":
        await db
          .insert(studioExternalIdsTable)
          .values({
            studioId,
            source: s.source,
            externalId: s.value,
            externalUrl: s.sourceUrl ?? null,
            lastSyncedAt: new Date(),
          })
          .onConflictDoNothing();
        break;
      case "parent": {
        const raw = this.parseRaw(s);
        const parentId = await this.resolveStudioId(
          s.value,
          s.source,
          raw.external_id
        );
        if (parentId !== studioId) {
          await db
            .update(studiosTable)
            .set({ parentStudioId: parentId, updatedAt: new Date() })
            .where(eq(studiosTable.id, studioId));
        }
        break;
      }
      default:
        throw new BadRequestError(
          `Unsupported studio suggestion type: ${s.type}`
        );
    }
  }

  // --- Apply: tag ---------------------------------------------------------

  private async applyTag(s: EnrichmentSuggestion): Promise<void> {
    const tagId = s.entityId;
    switch (s.type) {
      case "field":
        if (s.fieldKey === "description") {
          await tagsService.update(tagId, { description: s.value });
        } else {
          throw new BadRequestError(`Unsupported tag field: ${s.fieldKey}`);
        }
        break;
      case "alias":
        await db
          .insert(tagAliasesTable)
          .values({ tagId, name: s.value.slice(0, 255) })
          .onConflictDoNothing();
        break;
      case "external_id":
        await db
          .insert(tagExternalIdsTable)
          .values({
            tagId,
            source: s.source,
            externalId: s.value,
            externalUrl: s.sourceUrl ?? null,
            lastSyncedAt: new Date(),
          })
          .onConflictDoNothing();
        break;
      case "category": {
        const raw = this.parseRaw(s);
        const categoryId = await this.resolveTagCategoryId(s.value, raw.group);
        await db
          .update(tagsTable)
          .set({ categoryId, updatedAt: new Date() })
          .where(eq(tagsTable.id, tagId));
        break;
      }
      default:
        throw new BadRequestError(`Unsupported tag suggestion type: ${s.type}`);
    }
  }

  // --- Apply: scene (video) ----------------------------------------------

  private async applyScene(s: EnrichmentSuggestion): Promise<void> {
    const videoId = s.entityId;
    switch (s.type) {
      case "field": {
        const key = s.fieldKey ?? "";
        if (key === "title") {
          await db
            .update(videosTable)
            .set({ title: s.value, updatedAt: new Date() })
            .where(eq(videosTable.id, videoId));
        } else if (key === "description") {
          await db
            .update(videosTable)
            .set({ description: s.value, updatedAt: new Date() })
            .where(eq(videosTable.id, videoId));
        } else if (SCENE_METADATA_FIELDS.has(key)) {
          await db
            .insert(videoMetadataTable)
            .values({ videoId, key, value: s.value })
            .onConflictDoUpdate({
              target: [videoMetadataTable.videoId, videoMetadataTable.key],
              set: { value: s.value, updatedAt: new Date() },
            });
        } else {
          throw new BadRequestError(`Unsupported scene field: ${key}`);
        }
        break;
      }
      case "external_id":
        await db
          .insert(videoExternalIdsTable)
          .values({
            videoId,
            source: s.source,
            externalId: s.value,
            externalUrl: s.sourceUrl ?? null,
            lastSyncedAt: new Date(),
          })
          .onConflictDoNothing();
        break;
      case "performer": {
        const raw = this.parseRaw(s);
        const creatorId = await this.resolveCreatorId(
          s.value,
          s.source,
          raw.external_id
        );
        await db
          .insert(videoCreatorsTable)
          .values({ videoId, creatorId })
          .onConflictDoNothing();
        await this.autoEnrichRelatedEntity(
          "creator",
          creatorId,
          raw.source ?? s.source,
          raw.external_id
        );
        break;
      }
      case "studio": {
        const raw = this.parseRaw(s);
        const studioId = await this.resolveStudioId(
          s.value,
          s.source,
          raw.external_id
        );
        await studioAssignmentService.linkMany([videoId], [studioId]);
        await this.autoEnrichRelatedEntity(
          "studio",
          studioId,
          raw.source ?? s.source,
          raw.external_id
        );
        break;
      }
      case "tag": {
        const raw = this.parseRaw(s);
        const tagId = await this.resolveTagId(
          s.value,
          raw.source ?? s.source,
          raw.external_id
        );
        await db
          .insert(videoTagsTable)
          .values({ videoId, tagId })
          .onConflictDoNothing();
        await this.autoEnrichRelatedEntity(
          "tag",
          tagId,
          raw.source ?? s.source,
          raw.external_id
        );
        break;
      }
      case "image":
        // Scenes have no gallery; cache the cover as metadata for later use.
        await db
          .insert(videoMetadataTable)
          .values({ videoId, key: "cover_image_url", value: s.value })
          .onConflictDoUpdate({
            target: [videoMetadataTable.videoId, videoMetadataTable.key],
            set: { value: s.value, updatedAt: new Date() },
          });
        break;
      default:
        throw new BadRequestError(
          `Unsupported scene suggestion type: ${s.type}`
        );
    }
  }

  // --- Cross-entity resolvers (external id → name → alias → create) -------

  /**
   * Find the library entity a scene's performer / studio / tag proposal points
   * at, without creating anything: the source's external id first, then the
   * name ignoring case, then an alias. Accepting uses the same lookup, so the
   * review preview and the write always agree.
   */
  async findRelatedEntity(
    kind: RelatedKind,
    name: string,
    source?: string | null,
    externalId?: string | null
  ): Promise<RelatedMatch | null> {
    const t = RELATED_TABLES[kind];
    if (source && externalId) {
      const [ext] = await db
        .select({ id: t.extOwner, name: t.name })
        .from(t.ext)
        .innerJoin(t.table, eq(t.id, t.extOwner))
        .where(and(eq(t.extSource, source), eq(t.extId, externalId)))
        .limit(1);
      if (ext) return { id: ext.id, name: ext.name, via: "external_id" };
    }
    const lowered = name.trim().toLowerCase();
    const [byName] = await db
      .select({ id: t.id, name: t.name })
      .from(t.table)
      .where(sql`lower(${t.name}) = ${lowered}`)
      .limit(1);
    if (byName) return { id: byName.id, name: byName.name, via: "name" };
    const [byAlias] = await db
      .select({ id: t.id, name: t.name })
      .from(t.alias)
      .innerJoin(t.table, eq(t.id, t.aliasOwner))
      .where(sql`lower(${t.aliasName}) = ${lowered}`)
      .limit(1);
    if (byAlias) return { id: byAlias.id, name: byAlias.name, via: "alias" };
    return null;
  }

  /** What each pending performer / studio / tag proposal of a scene resolves to. */
  async previewResolution(
    entityType: EntityType,
    entityId: number
  ): Promise<ResolutionPreview[]> {
    if (env.DEMO_MODE) {
      return enrichmentDemoService.previewResolution(entityType, entityId);
    }
    const rows = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, entityType),
          eq(enrichmentSuggestionsTable.entityId, entityId),
          eq(enrichmentSuggestionsTable.status, "pending")
        )
      );
    const previews: ResolutionPreview[] = [];
    const tagLooks = new Map<
      number,
      { color: string | null; category: string | null }
    >();
    for (const row of rows) {
      const kind = RELATED_KIND_BY_TYPE[row.type];
      if (!kind) continue;
      const raw = this.parseRaw(row);
      const match = await this.findRelatedEntity(
        kind,
        row.value,
        raw.source ?? row.source,
        raw.external_id
      );
      if (match && kind === "tag") {
        let look = tagLooks.get(match.id);
        if (!look) {
          const [tag] = await db
            .select({
              color: tagsTable.color,
              category: tagCategoriesTable.name,
            })
            .from(tagsTable)
            .leftJoin(
              tagCategoriesTable,
              eq(tagCategoriesTable.id, tagsTable.categoryId)
            )
            .where(eq(tagsTable.id, match.id))
            .limit(1);
          look = { color: tag?.color ?? null, category: tag?.category ?? null };
          tagLooks.set(match.id, look);
        }
        Object.assign(match, look);
      }
      previews.push({ suggestion_id: row.id, kind, match });
    }
    return previews;
  }

  private async linkExternalId(
    kind: RelatedKind,
    id: number,
    source?: string | null,
    externalId?: string | null
  ): Promise<void> {
    if (!source || !externalId) return;
    const t = RELATED_TABLES[kind];
    await db
      .insert(t.ext)
      .values({
        [kind === "creator"
          ? "creatorId"
          : kind === "studio"
            ? "studioId"
            : "tagId"]: id,
        source,
        externalId,
        lastSyncedAt: new Date(),
      } as never)
      .onConflictDoNothing();
  }

  private async resolveCreatorId(
    name: string,
    source: string,
    externalId?: string | null
  ): Promise<number> {
    const found = await this.findRelatedEntity(
      "creator",
      name,
      source,
      externalId
    );
    if (found) return found.id;
    const created = await creatorsService.quickCreate(name);
    await this.linkExternalId("creator", created.id, source, externalId);
    return created.id;
  }

  private async resolveStudioId(
    name: string,
    source: string,
    externalId?: string | null
  ): Promise<number> {
    const found = await this.findRelatedEntity(
      "studio",
      name,
      source,
      externalId
    );
    if (found) return found.id;
    const created = await studiosService.create({ name });
    await this.linkExternalId("studio", created.id, source, externalId);
    return created.id;
  }

  private async resolveTagId(
    name: string,
    source?: string,
    externalId?: string | null
  ): Promise<number> {
    const found = await this.findRelatedEntity("tag", name, source, externalId);
    if (found) {
      // Remember the source's id so the next scene resolves without guessing.
      if (found.via !== "external_id")
        await this.linkExternalId("tag", found.id, source, externalId);
      return found.id;
    }
    const created = await tagsService.create({ name: name.slice(0, 255) });
    await this.linkExternalId("tag", created.id, source, externalId);
    return created.id;
  }

  private async autoEnrichRelatedEntity(
    entityType: Exclude<EnrichmentEntityType, "scene">,
    entityId: number,
    source?: string | null,
    externalId?: string | null
  ): Promise<void> {
    if (!source || !externalId) return;

    const request = await this.gatherInputs(entityType, entityId);
    let result;
    try {
      result = await getEnrichmentClient().enrich({
        ...request,
        sources: [source],
        external_ids: [{ source, external_id: externalId }],
      });
    } catch (error) {
      logger.warn(
        { entityType, entityId, source, externalId, error },
        "Related entity auto-enrichment failed"
      );
      return;
    }

    const acceptedTypes = AUTO_ACCEPT_RELATED_TYPES[entityType];
    const candidates = result.candidates.filter((candidate) =>
      acceptedTypes.has(candidate.type)
    );
    if (candidates.length === 0) return;

    const persisted = await db.transaction(async (tx) => {
      const canonicalEntityId = await this.lockCanonicalCreatorForWrite(
        tx,
        entityType,
        entityId
      );
      const rows = candidates.map((candidate) =>
        this.toSuggestionRow(entityType, canonicalEntityId, candidate)
      );
      const dedupHashes = new Set(rows.map((row) => row.dedupHash));
      await tx
        .insert(enrichmentSuggestionsTable)
        .values(rows)
        .onConflictDoNothing();

      const pending = await tx
        .select()
        .from(enrichmentSuggestionsTable)
        .where(
          and(
            eq(enrichmentSuggestionsTable.entityType, entityType),
            eq(enrichmentSuggestionsTable.entityId, canonicalEntityId),
            eq(enrichmentSuggestionsTable.status, "pending")
          )
        );
      return { canonicalEntityId, dedupHashes, pending };
    });

    for (const suggestion of persisted.pending) {
      if (
        !acceptedTypes.has(suggestion.type) ||
        !persisted.dedupHashes.has(suggestion.dedupHash)
      ) {
        continue;
      }
      try {
        await this.applyAutoAcceptedRelatedSuggestion(suggestion);
        await db
          .update(enrichmentSuggestionsTable)
          .set({ status: "accepted", updatedAt: new Date() })
          .where(eq(enrichmentSuggestionsTable.id, suggestion.id));
      } catch (error) {
        logger.warn(
          {
            suggestionId: suggestion.id,
            entityType,
            entityId,
            type: suggestion.type,
            error,
          },
          "Related entity auto-accept failed"
        );
      }
    }

    logger.info(
      {
        entityType,
        entityId: persisted.canonicalEntityId,
        source,
        externalId,
        candidates: candidates.length,
      },
      "Auto-enriched related entity from exact external id"
    );
  }

  private async applyAutoAcceptedRelatedSuggestion(
    suggestion: EnrichmentSuggestion
  ): Promise<void> {
    switch (suggestion.entityType as EnrichmentEntityType) {
      case "creator":
        await this.applyCreator(suggestion);
        break;
      case "studio":
        await this.applyStudio(suggestion);
        break;
      case "tag":
        await this.applyTag(suggestion);
        break;
      default:
        throw new BadRequestError(
          `Unsupported related entity type: ${suggestion.entityType}`
        );
    }
  }

  private async resolveTagCategoryId(
    name: string,
    group?: string | null
  ): Promise<number> {
    const [existing] = await db
      .select({ id: tagCategoriesTable.id })
      .from(tagCategoriesTable)
      .where(eq(tagCategoriesTable.name, name))
      .limit(1);
    if (existing) return existing.id;
    const [created] = await db
      .insert(tagCategoriesTable)
      .values({ name: name.slice(0, 255), group: group ?? null })
      .onConflictDoUpdate({
        target: tagCategoriesTable.name,
        set: { updatedAt: new Date() },
      })
      .returning({ id: tagCategoriesTable.id });
    return created.id;
  }

  // --- Helpers ------------------------------------------------------------

  private parseRaw(s: EnrichmentSuggestion): RelationalRaw {
    return (s.raw as RelationalRaw | null) ?? {};
  }

  private async getSuggestionOrThrow(
    id: number
  ): Promise<EnrichmentSuggestion> {
    const [row] = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(eq(enrichmentSuggestionsTable.id, id))
      .limit(1);
    if (!row) {
      throw new NotFoundError(`Suggestion not found with id: ${id}`);
    }
    return row;
  }

  private toSuggestionRow(
    entityType: EntityType,
    entityId: number,
    candidate: Candidate
  ) {
    return {
      entityType,
      entityId,
      type: candidate.type,
      fieldKey: candidate.field_key ?? null,
      value: candidate.value,
      source: candidate.source,
      sourceUrl: candidate.source_url ?? null,
      confidence: candidate.confidence ?? null,
      dedupHash: dedupHash(candidate),
      raw: candidate.raw ?? null,
    };
  }

  private toSuggestionDTO(row: EnrichmentSuggestion): SuggestionDTO {
    return {
      id: row.id,
      entity_type: row.entityType,
      entity_id: row.entityId,
      type: row.type,
      field_key: row.fieldKey,
      value: row.value,
      source: row.source,
      source_url: row.sourceUrl,
      confidence: row.confidence,
      face_match_score: row.faceMatchScore,
      cached_preview_path: row.cachedPreviewPath,
      image_width: row.imageWidth || null,
      image_height: row.imageHeight || null,
      status: row.status,
      dedup_hash: row.dedupHash,
      raw: row.raw,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private toRunDTO(row: EnrichmentRun): RunDTO {
    return {
      id: row.id,
      entity_type: row.entityType,
      entity_id: row.entityId,
      status: row.status,
      sources_used: row.sourcesUsed,
      suggestion_count: row.suggestionCount,
      errors: Array.isArray(row.errors)
        ? row.errors.filter(
            (value): value is string => typeof value === "string"
          )
        : null,
      started_at: row.startedAt.toISOString(),
      finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }
}

/** Stable dedup key per candidate (scoped to an entity by the unique index). */
function dedupHash(candidate: Candidate): string {
  const matchKey = candidateMatchKey(candidate.raw);
  return createHash("sha256")
    .update(
      `${candidate.type}|${candidate.field_key ?? ""}|${candidate.value}|${matchKey}`
    )
    .digest("hex");
}

function candidateMatchKey(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const match = (raw as Record<string, unknown>).match;
  if (!match || typeof match !== "object" || Array.isArray(match)) return "";
  const record = match as Record<string, unknown>;
  const source = typeof record.source === "string" ? record.source : "";
  const externalId =
    typeof record.external_id === "string" ? record.external_id : "";
  const name = typeof record.name === "string" ? record.name : "";
  return `${source}:${externalId || name}`;
}

/** Best-effort username from a profile URL (last non-empty path segment). */
function deriveUsername(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : url;
  } catch {
    return url;
  }
}

export const enrichmentService = new EnrichmentService();
