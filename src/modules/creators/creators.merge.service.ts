/**
 * Creator Merge Service
 *
 * Losslessly merges one creator ("from") into another ("into"): every child row
 * is reassigned to `into`, the old creator's name is preserved as an alias, a full
 * snapshot is written to the `creator_merges` audit table, and the `from` creator
 * is then deleted.
 *
 * Enrichment never auto-merges — it only proposes possible duplicates. This service
 * is the manual, explicit merge primitive those proposals are accepted into.
 */

import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  creatorsTable,
  videoCreatorsTable,
  creatorStudiosTable,
  creatorPlatformsTable,
  creatorAliasesTable,
  creatorSocialLinksTable,
  creatorGalleryMediaTable,
  creatorBodyModificationsTable,
  creatorExternalIdsTable,
  creatorMergesTable,
  enrichmentRunsTable,
  enrichmentSuggestionsTable,
} from "@/database/schema";
import { creatorFavoritesTable } from "@/database/schema";
import {
  creatorFaceEmbeddingsTable,
  videoFaceDetectionsTable,
} from "@/database/schema";
import { BadRequestError, ConflictError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { creatorsMergeDemoService } from "./creators.merge.demo.service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CreatorsMergeService {
  /**
   * Merge `fromId` into `intoId`. Returns the surviving (`into`) creator.
   */
  async mergeCreators(
    fromId: number,
    intoId: number,
    reason?: string
  ): Promise<{ id: number }> {
    if (fromId === intoId) {
      throw new BadRequestError("Cannot merge a creator into itself");
    }

    if (env.DEMO_MODE) {
      return creatorsMergeDemoService.mergeCreators(fromId, intoId, reason);
    }

    const merged = await db.transaction(async (tx) => {
      // Lock both rows in a deterministic order. Overlapping merge requests then
      // serialize instead of moving the same graph twice or deadlocking.
      const locked = await tx
        .select()
        .from(creatorsTable)
        .where(inArray(creatorsTable.id, [fromId, intoId]))
        .orderBy(asc(creatorsTable.id))
        .for("update");
      const from = locked.find((creator) => creator.id === fromId);
      const into = locked.find((creator) => creator.id === intoId);

      if (!from) {
        const [priorMerge] = await tx
          .select({ intoCreatorId: creatorMergesTable.intoCreatorId })
          .from(creatorMergesTable)
          .where(eq(creatorMergesTable.fromCreatorId, fromId))
          .orderBy(asc(creatorMergesTable.id))
          .limit(1);
        if (priorMerge?.intoCreatorId === intoId && into) {
          return { id: intoId };
        }
        throw new NotFoundError(`Creator not found with id: ${fromId}`);
      }
      if (!into) {
        throw new NotFoundError(`Creator not found with id: ${intoId}`);
      }

      const targetBefore = { ...into };
      const discardedConflicts: Record<string, unknown[]> = {};
      const [targetProfileMedia] = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(
          and(
            eq(creatorGalleryMediaTable.creatorId, intoId),
            eq(creatorGalleryMediaTable.isProfilePicture, true)
          )
        )
        .orderBy(asc(creatorGalleryMediaTable.id))
        .limit(1);
      const [targetMainMedia] = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(
          and(
            eq(creatorGalleryMediaTable.creatorId, intoId),
            eq(creatorGalleryMediaTable.isMainPicture, true)
          )
        )
        .orderBy(asc(creatorGalleryMediaTable.id))
        .limit(1);
      const [targetPrimaryFace] = await tx
        .select({ id: creatorFaceEmbeddingsTable.id })
        .from(creatorFaceEmbeddingsTable)
        .where(
          and(
            eq(creatorFaceEmbeddingsTable.creatorId, intoId),
            eq(creatorFaceEmbeddingsTable.isPrimary, true)
          )
        )
        .orderBy(asc(creatorFaceEmbeddingsTable.id))
        .limit(1);

      // A platform is a single profile per creator. Exact duplicates can be
      // collapsed, but two different profiles require explicit user resolution.
      discardedConflicts.platforms = await this.movePlatforms(
        tx,
        fromId,
        intoId
      );

      // --- Junction tables (composite PK): collide on the non-creator column ---
      discardedConflicts.videos = await this.moveScoped(
        tx,
        videoCreatorsTable,
        videoCreatorsTable.creatorId,
        videoCreatorsTable.videoId,
        fromId,
        intoId
      );
      discardedConflicts.studios = await this.moveScoped(
        tx,
        creatorStudiosTable,
        creatorStudiosTable.creatorId,
        creatorStudiosTable.studioId,
        fromId,
        intoId
      );
      discardedConflicts.favorites = await this.moveScoped(
        tx,
        creatorFavoritesTable,
        creatorFavoritesTable.creatorId,
        creatorFavoritesTable.userId,
        fromId,
        intoId
      );

      // --- Child tables with a (creatorId, X) unique constraint ---
      discardedConflicts.aliases = await this.moveScoped(
        tx,
        creatorAliasesTable,
        creatorAliasesTable.creatorId,
        creatorAliasesTable.name,
        fromId,
        intoId
      );

      // External identity is globally unique on (source, external_id), so two
      // creators cannot own the same identity. A plain reassignment preserves
      // equal-looking IDs that came from different providers.
      await tx
        .update(creatorExternalIdsTable)
        .set({ creatorId: intoId })
        .where(eq(creatorExternalIdsTable.creatorId, fromId));

      // --- Child tables with no conflicting constraint: plain reassignment ---
      await tx
        .update(creatorSocialLinksTable)
        .set({ creatorId: intoId })
        .where(eq(creatorSocialLinksTable.creatorId, fromId));
      await tx
        .update(creatorGalleryMediaTable)
        .set({ creatorId: intoId })
        .where(eq(creatorGalleryMediaTable.creatorId, fromId));
      await tx
        .update(creatorBodyModificationsTable)
        .set({ creatorId: intoId })
        .where(eq(creatorBodyModificationsTable.creatorId, fromId));
      await tx
        .update(creatorFaceEmbeddingsTable)
        .set({ creatorId: intoId })
        .where(eq(creatorFaceEmbeddingsTable.creatorId, fromId));
      await tx
        .update(videoFaceDetectionsTable)
        .set({ matchedCreatorId: intoId })
        .where(eq(videoFaceDetectionsTable.matchedCreatorId, fromId));

      // Enrichment tables are polymorphic and intentionally have no FK. Move
      // them explicitly so deleting the source cannot leave invisible orphans.
      discardedConflicts.enrichmentSuggestions =
        await this.moveEnrichmentSuggestions(tx, fromId, intoId);
      await tx
        .update(enrichmentRunsTable)
        .set({ entityId: intoId })
        .where(
          and(
            eq(enrichmentRunsTable.entityType, "creator"),
            eq(enrichmentRunsTable.entityId, fromId)
          )
        );

      // The target is canonical. Fill only its missing top-level metadata from
      // the source; conflicting source values remain recoverable in the audit.
      const fillableKeys = [
        "description",
        "profilePicturePath",
        "mainPicturePath",
        "faceThumbnailPath",
        "gender",
        "birthDate",
        "deathDate",
        "ethnicity",
        "country",
        "birthplace",
        "eyeColor",
        "hairColor",
        "heightCm",
        "cupSize",
        "bandSize",
        "waistSize",
        "hipSize",
        "breastType",
        "careerStartYear",
        "careerEndYear",
      ] as const;
      const creatorUpdates: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of fillableKeys) {
        if (into[key] === null && from[key] !== null) {
          creatorUpdates[key] = from[key];
        }
      }
      await tx
        .update(creatorsTable)
        .set(creatorUpdates)
        .where(eq(creatorsTable.id, intoId));

      // --- Preserve the old name as an alias on `into` (skip if it already is) ---
      if (from.name !== into.name) {
        await tx
          .insert(creatorAliasesTable)
          .values({
            creatorId: intoId,
            name: from.name,
            note: `Merged from creator #${fromId}`,
          })
          .onConflictDoNothing();
      }

      await this.normalizeGalleryRoles(
        tx,
        intoId,
        targetProfileMedia?.id,
        targetMainMedia?.id
      );
      await this.normalizePrimaryFace(tx, intoId, targetPrimaryFace?.id);

      // The audit stores every value that is intentionally collapsed. Rows that
      // are reassigned remain live on the survivor and do not need duplication.
      await tx.insert(creatorMergesTable).values({
        fromCreatorId: fromId,
        intoCreatorId: intoId,
        fromName: from.name,
        snapshot: {
          ...from,
          auditVersion: 2,
          targetBefore,
          discardedConflicts,
        },
        reason: reason ?? null,
      });

      // --- Remove the merged-away creator ---
      await tx.delete(creatorsTable).where(eq(creatorsTable.id, fromId));

      return { id: intoId };
    });

    // Logging after the transaction promise resolves ensures we never announce
    // success for a transaction that ultimately failed to commit.
    logger.info(
      { fromId, intoId, reason },
      "Merged creator into target creator"
    );
    return merged;
  }

  /**
   * Reassign `from`→`into` for a table where `(creatorCol, scopeCol)` must stay
   * unique: delete the `from` rows whose `scopeCol` value already exists on
   * `into`, then reassign the rest. Merge volume is tiny, so the in-memory key
   * set is fine.
   */
  private async moveScoped(
    tx: Tx,
    table: any,
    creatorCol: any,
    scopeCol: any,
    fromId: number,
    intoId: number
  ): Promise<unknown[]> {
    const intoRows = await tx
      .select({ scope: scopeCol })
      .from(table)
      .where(eq(creatorCol, intoId));

    const existing = intoRows
      .map((r: { scope: unknown }) => r.scope)
      .filter((v: unknown): v is string | number => v !== null);

    let conflicts: unknown[] = [];
    if (existing.length > 0) {
      conflicts = await tx
        .select()
        .from(table)
        .where(and(eq(creatorCol, fromId), inArray(scopeCol, existing)));
      await tx
        .delete(table)
        .where(and(eq(creatorCol, fromId), inArray(scopeCol, existing)));
    }

    // Every scoped table reassigns its `creatorId` column (Drizzle `.set()` keys
    // are JS property names, which are all `creatorId` here).
    await tx
      .update(table)
      .set({ creatorId: intoId })
      .where(and(eq(creatorCol, fromId), ne(creatorCol, intoId)));

    return conflicts;
  }

  private async movePlatforms(
    tx: Tx,
    fromId: number,
    intoId: number
  ): Promise<unknown[]> {
    const sourceRows = await tx
      .select()
      .from(creatorPlatformsTable)
      .where(eq(creatorPlatformsTable.creatorId, fromId));
    const targetRows = await tx
      .select()
      .from(creatorPlatformsTable)
      .where(eq(creatorPlatformsTable.creatorId, intoId));
    const targetByPlatform = new Map(
      targetRows.map((row) => [row.platformId, row])
    );
    const duplicates: typeof sourceRows = [];

    for (const source of sourceRows) {
      const target = targetByPlatform.get(source.platformId);
      if (!target) continue;
      const exactDuplicate =
        source.username === target.username &&
        source.profileUrl === target.profileUrl;
      if (!exactDuplicate) {
        throw new ConflictError(
          `Creators have different profiles for platform ${source.platformId}; resolve that profile before merging`
        );
      }
      duplicates.push(source);
    }

    if (duplicates.length > 0) {
      await tx.delete(creatorPlatformsTable).where(
        inArray(
          creatorPlatformsTable.id,
          duplicates.map((row) => row.id)
        )
      );
    }
    await tx
      .update(creatorPlatformsTable)
      .set({ creatorId: intoId })
      .where(eq(creatorPlatformsTable.creatorId, fromId));
    return duplicates;
  }

  private async moveEnrichmentSuggestions(
    tx: Tx,
    fromId: number,
    intoId: number
  ): Promise<unknown[]> {
    const targetRows = await tx
      .select({ dedupHash: enrichmentSuggestionsTable.dedupHash })
      .from(enrichmentSuggestionsTable)
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, "creator"),
          eq(enrichmentSuggestionsTable.entityId, intoId)
        )
      );
    const targetHashes = targetRows.map((row) => row.dedupHash);
    let duplicates: unknown[] = [];

    if (targetHashes.length > 0) {
      duplicates = await tx
        .select()
        .from(enrichmentSuggestionsTable)
        .where(
          and(
            eq(enrichmentSuggestionsTable.entityType, "creator"),
            eq(enrichmentSuggestionsTable.entityId, fromId),
            inArray(enrichmentSuggestionsTable.dedupHash, targetHashes)
          )
        );
      await tx
        .delete(enrichmentSuggestionsTable)
        .where(
          and(
            eq(enrichmentSuggestionsTable.entityType, "creator"),
            eq(enrichmentSuggestionsTable.entityId, fromId),
            inArray(enrichmentSuggestionsTable.dedupHash, targetHashes)
          )
        );
    }

    await tx
      .update(enrichmentSuggestionsTable)
      .set({ entityId: intoId, updatedAt: new Date() })
      .where(
        and(
          eq(enrichmentSuggestionsTable.entityType, "creator"),
          eq(enrichmentSuggestionsTable.entityId, fromId)
        )
      );
    return duplicates;
  }

  private async normalizeGalleryRoles(
    tx: Tx,
    creatorId: number,
    preferredProfileId?: number,
    preferredMainId?: number
  ): Promise<void> {
    for (const [column, preferredId] of [
      [creatorGalleryMediaTable.isProfilePicture, preferredProfileId],
      [creatorGalleryMediaTable.isMainPicture, preferredMainId],
    ] as const) {
      const rows = await tx
        .select({ id: creatorGalleryMediaTable.id })
        .from(creatorGalleryMediaTable)
        .where(
          and(
            eq(creatorGalleryMediaTable.creatorId, creatorId),
            eq(column, true)
          )
        )
        .orderBy(asc(creatorGalleryMediaTable.id));
      if (rows.length <= 1) continue;
      const keepId =
        preferredId && rows.some((row) => row.id === preferredId)
          ? preferredId
          : rows[0].id;
      await tx
        .update(creatorGalleryMediaTable)
        .set({
          [column === creatorGalleryMediaTable.isProfilePicture
            ? "isProfilePicture"
            : "isMainPicture"]: false,
        })
        .where(
          and(
            eq(creatorGalleryMediaTable.creatorId, creatorId),
            inArray(
              creatorGalleryMediaTable.id,
              rows.filter((row) => row.id !== keepId).map((row) => row.id)
            )
          )
        );
    }
  }

  private async normalizePrimaryFace(
    tx: Tx,
    creatorId: number,
    preferredId?: number
  ): Promise<void> {
    const rows = await tx
      .select({ id: creatorFaceEmbeddingsTable.id })
      .from(creatorFaceEmbeddingsTable)
      .where(
        and(
          eq(creatorFaceEmbeddingsTable.creatorId, creatorId),
          eq(creatorFaceEmbeddingsTable.isPrimary, true)
        )
      )
      .orderBy(asc(creatorFaceEmbeddingsTable.id));
    if (rows.length <= 1) return;
    const keepId =
      preferredId && rows.some((row) => row.id === preferredId)
        ? preferredId
        : rows[0].id;
    await tx
      .update(creatorFaceEmbeddingsTable)
      .set({ isPrimary: false })
      .where(
        and(
          eq(creatorFaceEmbeddingsTable.creatorId, creatorId),
          inArray(
            creatorFaceEmbeddingsTable.id,
            rows.filter((row) => row.id !== keepId).map((row) => row.id)
          )
        )
      );
  }
}

export const creatorsMergeService = new CreatorsMergeService();
