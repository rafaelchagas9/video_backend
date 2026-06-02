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

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/config/drizzle";
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
  type Creator,
} from "@/database/schema";
import { creatorFavoritesTable } from "@/database/schema";
import {
  creatorFaceEmbeddingsTable,
  videoFaceDetectionsTable,
} from "@/database/schema";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CreatorsMergeService {
  /**
   * Merge `fromId` into `intoId`. Returns the surviving (`into`) creator.
   */
  async mergeCreators(
    fromId: number,
    intoId: number,
    reason?: string,
  ): Promise<Creator> {
    if (fromId === intoId) {
      throw new BadRequestError("Cannot merge a creator into itself");
    }

    return db.transaction(async (tx) => {
      const [from] = await tx
        .select()
        .from(creatorsTable)
        .where(eq(creatorsTable.id, fromId))
        .limit(1);
      if (!from) {
        throw new NotFoundError(`Creator not found with id: ${fromId}`);
      }

      const [into] = await tx
        .select()
        .from(creatorsTable)
        .where(eq(creatorsTable.id, intoId))
        .limit(1);
      if (!into) {
        throw new NotFoundError(`Creator not found with id: ${intoId}`);
      }

      // --- Junction tables (composite PK): collide on the non-creator column ---
      await this.moveScoped(
        tx,
        videoCreatorsTable,
        videoCreatorsTable.creatorId,
        videoCreatorsTable.videoId,
        fromId,
        intoId,
      );
      await this.moveScoped(
        tx,
        creatorStudiosTable,
        creatorStudiosTable.creatorId,
        creatorStudiosTable.studioId,
        fromId,
        intoId,
      );
      await this.moveScoped(
        tx,
        creatorFavoritesTable,
        creatorFavoritesTable.creatorId,
        creatorFavoritesTable.userId,
        fromId,
        intoId,
      );

      // --- Child tables with a (creatorId, X) unique constraint ---
      await this.moveScoped(
        tx,
        creatorPlatformsTable,
        creatorPlatformsTable.creatorId,
        creatorPlatformsTable.platformId,
        fromId,
        intoId,
      );
      await this.moveScoped(
        tx,
        creatorAliasesTable,
        creatorAliasesTable.creatorId,
        creatorAliasesTable.name,
        fromId,
        intoId,
      );

      // --- external_ids: unique is global on (source, external_id); the only
      // possible collision is between `from` and `into` themselves. Compare on
      // external_id (a given external_id can only exist once across all sources
      // we use), which keeps this a single-column scoped move. ---
      await this.moveScoped(
        tx,
        creatorExternalIdsTable,
        creatorExternalIdsTable.creatorId,
        creatorExternalIdsTable.externalId,
        fromId,
        intoId,
      );

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

      // --- Audit row with full snapshot (survives the delete below) ---
      await tx.insert(creatorMergesTable).values({
        fromCreatorId: fromId,
        intoCreatorId: intoId,
        fromName: from.name,
        snapshot: from,
        reason: reason ?? null,
      });

      // --- Remove the merged-away creator ---
      await tx.delete(creatorsTable).where(eq(creatorsTable.id, fromId));

      const [merged] = await tx
        .select()
        .from(creatorsTable)
        .where(eq(creatorsTable.id, intoId))
        .limit(1);

      logger.info(
        { fromId, intoId, reason },
        "Merged creator into target creator",
      );

      return merged;
    });
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
    intoId: number,
  ): Promise<void> {
    const intoRows = await tx
      .select({ scope: scopeCol })
      .from(table)
      .where(eq(creatorCol, intoId));

    const existing = intoRows
      .map((r: { scope: unknown }) => r.scope)
      .filter((v: unknown): v is string | number => v !== null);

    if (existing.length > 0) {
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
  }
}

export const creatorsMergeService = new CreatorsMergeService();
