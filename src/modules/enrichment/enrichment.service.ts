/**
 * Enrichment Service
 *
 * Orchestrates enrichment across entity types (creator / studio / scene / tag):
 * calls the Python service for candidates, stores them as reviewable suggestions,
 * and (on explicit accept) writes them through the existing entity writers. Nothing
 * is ever auto-applied.
 */

import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  creatorsTable,
  creatorAliasesTable,
  creatorPlatformsTable,
  creatorExternalIdsTable,
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
  videoStudiosTable,
  videoTagsTable,
  videoExternalIdsTable,
  enrichmentSuggestionsTable,
  enrichmentRunsTable,
  type EnrichmentSuggestion,
  type EnrichmentRun,
  type EnrichmentEntityType,
  type NewCreator,
} from "@/database/schema";
import { AppError, BadRequestError, NotFoundError } from "@/utils/errors";
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
import type {
  Candidate,
  EnrichRequest,
  EntityType,
  RelationalRaw,
  RunEnrichmentOptions,
  RunDTO,
  SuggestionDTO,
} from "./enrichment.types";

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
  career_start_year: (v) => ({ careerStartYear: toInt(v, "career_start_year") }),
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
    options: RunEnrichmentOptions = {},
  ): Promise<RunDTO> {
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

    let inserted = 0;
    if (result.candidates.length > 0) {
      const rows = result.candidates.map((c) =>
        this.toSuggestionRow(entityType, entityId, c),
      );
      const insertedRows = await db
        .insert(enrichmentSuggestionsTable)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: enrichmentSuggestionsTable.id });
      inserted = insertedRows.length;
    }

    const [updated] = await db
      .update(enrichmentRunsTable)
      .set({
        status: "success",
        sourcesUsed: result.sources_used,
        suggestionCount: inserted,
        errors: result.errors.length > 0 ? result.errors : null,
        finishedAt: new Date(),
      })
      .where(eq(enrichmentRunsTable.id, run.id))
      .returning();

    logger.info(
      {
        entityType,
        entityId,
        runId: run.id,
        candidates: result.candidates.length,
        inserted,
        sources: result.sources_used,
      },
      "Enrichment run complete",
    );

    return this.toRunDTO(updated);
  }

  /** Build the discovery request for the Python service, per entity type. */
  private async gatherInputs(
    entityType: EntityType,
    entityId: number,
    options: RunEnrichmentOptions = {},
  ): Promise<EnrichRequest> {
    const applyRunOptions = (request: EnrichRequest): EnrichRequest => ({
      ...request,
      name: options.search_name ?? request.name,
      ...(options.search_name !== undefined ? { title: options.search_name } : {}),
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
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
        return applyRunOptions({
          entity_type: "creator",
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
        return applyRunOptions({
          entity_type: "studio",
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
        return applyRunOptions({
          entity_type: "tag",
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
        return applyRunOptions({
          entity_type: "scene",
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
    filters: ListSuggestionsFilters,
  ): Promise<SuggestionDTO[]> {
    const conditions = [];
    if (filters.entity_type) {
      conditions.push(
        eq(enrichmentSuggestionsTable.entityType, filters.entity_type),
      );
    }
    if (filters.entity_id !== undefined) {
      conditions.push(
        eq(enrichmentSuggestionsTable.entityId, filters.entity_id),
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
        enrichmentSuggestionsTable.id,
      );

    return rows.map((r) => this.toSuggestionDTO(r));
  }

  async listRuns(
    entityType: EntityType,
    entityId: number,
  ): Promise<RunDTO[]> {
    const rows = await db
      .select()
      .from(enrichmentRunsTable)
      .where(
        and(
          eq(enrichmentRunsTable.entityType, entityType),
          eq(enrichmentRunsTable.entityId, entityId),
        ),
      )
      .orderBy(desc(enrichmentRunsTable.startedAt));
    return rows.map((r) => this.toRunDTO(r));
  }

  /**
   * Accept a pending suggestion: write it through the existing entity writers,
   * then mark it accepted.
   */
  async acceptSuggestion(id: number): Promise<SuggestionDTO> {
    const suggestion = await this.getSuggestionOrThrow(id);
    if (suggestion.status !== "pending") {
      throw new BadRequestError(
        `Suggestion ${id} is not pending (status: ${suggestion.status})`,
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
          `Unsupported entity type: ${suggestion.entityType}`,
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
      "Accepted enrichment suggestion",
    );

    return this.toSuggestionDTO(updated);
  }

  async rejectSuggestion(id: number): Promise<SuggestionDTO> {
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
    entityId: number,
  ): Promise<void> {
    await db
      .delete(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, entityType),
          eq(enrichmentSuggestionsTable.entityId, entityId),
        ),
      );
    await db
      .delete(enrichmentRunsTable)
      .where(
        and(
          eq(enrichmentRunsTable.entityType, entityType),
          eq(enrichmentRunsTable.entityId, entityId),
        ),
      );
  }

  // --- Apply: creator -----------------------------------------------------

  private async applyCreator(s: EnrichmentSuggestion): Promise<void> {
    const creatorId = s.entityId;
    switch (s.type) {
      case "image":
        await creatorsSocialService.addGalleryMediaFromUrl(
          creatorId,
          s.value,
          `From ${s.source}`,
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
          `Unsupported creator suggestion type: ${s.type}`,
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
          raw.external_id,
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
          `Unsupported studio suggestion type: ${s.type}`,
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
          raw.external_id,
        );
        await db
          .insert(videoCreatorsTable)
          .values({ videoId, creatorId })
          .onConflictDoNothing();
        await this.autoEnrichRelatedEntity(
          "creator",
          creatorId,
          raw.source ?? s.source,
          raw.external_id,
        );
        break;
      }
      case "studio": {
        const raw = this.parseRaw(s);
        const studioId = await this.resolveStudioId(
          s.value,
          s.source,
          raw.external_id,
        );
        await db
          .insert(videoStudiosTable)
          .values({ videoId, studioId })
          .onConflictDoNothing();
        await this.autoEnrichRelatedEntity(
          "studio",
          studioId,
          raw.source ?? s.source,
          raw.external_id,
        );
        break;
      }
      case "tag": {
        const raw = this.parseRaw(s);
        const tagId = await this.resolveTagId(
          s.value,
          raw.source ?? s.source,
          raw.external_id,
        );
        await db
          .insert(videoTagsTable)
          .values({ videoId, tagId })
          .onConflictDoNothing();
        await this.autoEnrichRelatedEntity(
          "tag",
          tagId,
          raw.source ?? s.source,
          raw.external_id,
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
          `Unsupported scene suggestion type: ${s.type}`,
        );
    }
  }

  // --- Cross-entity resolvers (external id → name → create) ---------------

  private async resolveCreatorId(
    name: string,
    source: string,
    externalId?: string | null,
  ): Promise<number> {
    if (externalId) {
      const [ext] = await db
        .select({ creatorId: creatorExternalIdsTable.creatorId })
        .from(creatorExternalIdsTable)
        .where(
          and(
            eq(creatorExternalIdsTable.source, source),
            eq(creatorExternalIdsTable.externalId, externalId),
          ),
        )
        .limit(1);
      if (ext) return ext.creatorId;
    }
    const [byName] = await db
      .select({ id: creatorsTable.id })
      .from(creatorsTable)
      .where(eq(creatorsTable.name, name))
      .limit(1);
    if (byName) return byName.id;

    const created = await creatorsService.quickCreate(name);
    if (externalId) {
      await db
        .insert(creatorExternalIdsTable)
        .values({ creatorId: created.id, source, externalId, lastSyncedAt: new Date() })
        .onConflictDoNothing();
    }
    return created.id;
  }

  private async resolveStudioId(
    name: string,
    source: string,
    externalId?: string | null,
  ): Promise<number> {
    if (externalId) {
      const [ext] = await db
        .select({ studioId: studioExternalIdsTable.studioId })
        .from(studioExternalIdsTable)
        .where(
          and(
            eq(studioExternalIdsTable.source, source),
            eq(studioExternalIdsTable.externalId, externalId),
          ),
        )
        .limit(1);
      if (ext) return ext.studioId;
    }
    const [byName] = await db
      .select({ id: studiosTable.id })
      .from(studiosTable)
      .where(eq(studiosTable.name, name))
      .limit(1);
    if (byName) return byName.id;

    const created = await studiosService.create({ name });
    if (externalId) {
      await db
        .insert(studioExternalIdsTable)
        .values({ studioId: created.id, source, externalId, lastSyncedAt: new Date() })
        .onConflictDoNothing();
    }
    return created.id;
  }

  private async resolveTagId(
    name: string,
    source?: string,
    externalId?: string | null,
  ): Promise<number> {
    if (source && externalId) {
      const [ext] = await db
        .select({ tagId: tagExternalIdsTable.tagId })
        .from(tagExternalIdsTable)
        .where(
          and(
            eq(tagExternalIdsTable.source, source),
            eq(tagExternalIdsTable.externalId, externalId),
          ),
        )
        .limit(1);
      if (ext) return ext.tagId;
    }

    const [byName] = await db
      .select({ id: tagsTable.id })
      .from(tagsTable)
      .where(eq(tagsTable.name, name))
      .limit(1);
    if (byName) {
      if (source && externalId) {
        await db
          .insert(tagExternalIdsTable)
          .values({
            tagId: byName.id,
            source,
            externalId,
            lastSyncedAt: new Date(),
          })
          .onConflictDoNothing();
      }
      return byName.id;
    }

    const created = await tagsService.create({ name: name.slice(0, 255) });
    if (source && externalId) {
      await db
        .insert(tagExternalIdsTable)
        .values({
          tagId: created.id,
          source,
          externalId,
          lastSyncedAt: new Date(),
        })
        .onConflictDoNothing();
    }
    return created.id;
  }

  private async autoEnrichRelatedEntity(
    entityType: Exclude<EnrichmentEntityType, "scene">,
    entityId: number,
    source?: string | null,
    externalId?: string | null,
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
        "Related entity auto-enrichment failed",
      );
      return;
    }

    const acceptedTypes = AUTO_ACCEPT_RELATED_TYPES[entityType];
    const candidates = result.candidates.filter((candidate) =>
      acceptedTypes.has(candidate.type),
    );
    if (candidates.length === 0) return;

    const rows = candidates.map((candidate) =>
      this.toSuggestionRow(entityType, entityId, candidate),
    );
    const dedupHashes = new Set(rows.map((row) => row.dedupHash));
    await db
      .insert(enrichmentSuggestionsTable)
      .values(rows)
      .onConflictDoNothing();

    const pending = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, entityType),
          eq(enrichmentSuggestionsTable.entityId, entityId),
          eq(enrichmentSuggestionsTable.status, "pending"),
        ),
      );

    for (const suggestion of pending) {
      if (
        !acceptedTypes.has(suggestion.type) ||
        !dedupHashes.has(suggestion.dedupHash)
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
          "Related entity auto-accept failed",
        );
      }
    }

    logger.info(
      {
        entityType,
        entityId,
        source,
        externalId,
        candidates: candidates.length,
      },
      "Auto-enriched related entity from exact external id",
    );
  }

  private async applyAutoAcceptedRelatedSuggestion(
    suggestion: EnrichmentSuggestion,
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
          `Unsupported related entity type: ${suggestion.entityType}`,
        );
    }
  }

  private async resolveTagCategoryId(
    name: string,
    group?: string | null,
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
    id: number,
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
    candidate: Candidate,
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
      errors: row.errors,
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
      `${candidate.type}|${candidate.field_key ?? ""}|${candidate.value}|${matchKey}`,
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
