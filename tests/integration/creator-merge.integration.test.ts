import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { TestApp } from "../helpers/test-app";
import { createTestApp } from "../helpers/test-app";

/**
 * Phase 0.5 — verifies `creatorsMergeService.mergeCreators` losslessly folds one
 * creator into another: child rows are reassigned (with conflict de-duplication),
 * the old name becomes an alias, an audit row with a snapshot is written, and the
 * merged-away creator is deleted.
 *
 * DB-bound modules are imported dynamically AFTER `createTestApp()` so they bind to
 * the throwaway test Postgres container (mirrors `seedVideoFixture`).
 */
describe("creator merge (Phase 0.5)", () => {
  let ctx: TestApp | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it("merges one creator into another losslessly", async () => {
    const { db } = await import("@/config/drizzle");
    const {
      creatorsTable,
      creatorAliasesTable,
      creatorSocialLinksTable,
      creatorExternalIdsTable,
      creatorPlatformsTable,
      creatorMergesTable,
      enrichmentSuggestionsTable,
      enrichmentRunsTable,
      platformsTable,
    } = await import("@/database/schema");
    const { creatorsMergeService } =
      await import("@/modules/creators/creators.merge.service");

    // --- Arrange ----------------------------------------------------------
    const [platform] = await db
      .insert(platformsTable)
      .values({ name: "OnlyFans", baseUrl: "https://onlyfans.com" })
      .returning();

    const [into] = await db
      .insert(creatorsTable)
      .values({ name: "Canonical Creator", country: "Brazil" })
      .returning();
    const [from] = await db
      .insert(creatorsTable)
      .values({
        name: "Duplicate Creator",
        description: "Source-only description",
        country: "Canada",
      })
      .returning();

    // Aliases: one shared (collision) + one unique per creator.
    await db.insert(creatorAliasesTable).values([
      { creatorId: into.id, name: "Shared Alias" },
      { creatorId: into.id, name: "Into Only" },
      { creatorId: from.id, name: "Shared Alias" },
      { creatorId: from.id, name: "From Only" },
    ]);

    // Plain move (no unique constraint).
    await db.insert(creatorSocialLinksTable).values({
      creatorId: from.id,
      platformName: "Twitter",
      url: "https://x.com/dupe",
    });

    // Equal-looking IDs from different providers are both valid identities.
    await db.insert(creatorExternalIdsTable).values([
      {
        creatorId: into.id,
        source: "stashdb",
        externalId: "shared-111",
      },
      {
        creatorId: from.id,
        source: "theporndb",
        externalId: "shared-111",
      },
    ]);

    // Platform profile collision: both have a profile on the same platform.
    await db.insert(creatorPlatformsTable).values([
      {
        creatorId: into.id,
        platformId: platform.id,
        username: "into_handle",
        profileUrl: "https://onlyfans.com/into",
      },
      {
        creatorId: from.id,
        platformId: platform.id,
        username: "into_handle",
        profileUrl: "https://onlyfans.com/into",
      },
    ]);

    await db.insert(enrichmentSuggestionsTable).values({
      entityType: "creator",
      entityId: from.id,
      type: "alias",
      value: "Suggested Alias",
      source: "stashdb",
      dedupHash: `creator-merge-${from.id}`,
    });
    await db.insert(enrichmentRunsTable).values({
      entityType: "creator",
      entityId: from.id,
      status: "success",
    });

    // --- Act --------------------------------------------------------------
    const merged = await creatorsMergeService.mergeCreators(
      from.id,
      into.id,
      "integration test"
    );
    expect(merged.id).toBe(into.id);

    // --- Assert -----------------------------------------------------------
    // `from` is gone.
    const remaining = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.id, from.id));
    expect(remaining).toHaveLength(0);

    // Aliases: union deduped + old name preserved as alias.
    const aliases = await db
      .select()
      .from(creatorAliasesTable)
      .where(eq(creatorAliasesTable.creatorId, into.id));
    const aliasNames = aliases.map((a) => a.name).sort();
    expect(aliasNames).toEqual(
      ["Duplicate Creator", "From Only", "Into Only", "Shared Alias"].sort()
    );

    // Social link moved.
    const socials = await db
      .select()
      .from(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.creatorId, into.id));
    expect(socials).toHaveLength(1);
    expect(socials[0].url).toBe("https://x.com/dupe");

    // External id moved.
    const externalIds = await db
      .select()
      .from(creatorExternalIdsTable)
      .where(eq(creatorExternalIdsTable.creatorId, into.id));
    expect(externalIds).toHaveLength(2);
    expect(externalIds.map((row) => row.source).sort()).toEqual([
      "stashdb",
      "theporndb",
    ]);

    // Platform collision resolved: only `into`'s original profile survives.
    const platforms = await db
      .select()
      .from(creatorPlatformsTable)
      .where(eq(creatorPlatformsTable.creatorId, into.id));
    expect(platforms).toHaveLength(1);
    expect(platforms[0].username).toBe("into_handle");

    const [survivor] = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.id, into.id));
    expect(survivor.description).toBe("Source-only description");
    expect(survivor.country).toBe("Brazil");

    const suggestions = await db
      .select()
      .from(enrichmentSuggestionsTable)
      .where(eq(enrichmentSuggestionsTable.entityId, into.id));
    expect(suggestions).toHaveLength(1);
    const runs = await db
      .select()
      .from(enrichmentRunsTable)
      .where(eq(enrichmentRunsTable.entityId, into.id));
    expect(runs).toHaveLength(1);

    // Audit row with snapshot.
    const merges = await db
      .select()
      .from(creatorMergesTable)
      .where(eq(creatorMergesTable.intoCreatorId, into.id));
    expect(merges).toHaveLength(1);
    expect(merges[0].fromCreatorId).toBe(from.id);
    expect(merges[0].fromName).toBe("Duplicate Creator");
    expect(merges[0].reason).toBe("integration test");
    expect(merges[0].snapshot).toMatchObject({
      id: from.id,
      name: "Duplicate Creator",
    });
    expect(merges[0].snapshot).toMatchObject({
      auditVersion: 2,
      discardedConflicts: {
        platforms: [expect.objectContaining({ creatorId: from.id })],
      },
    });
  });

  it("rolls back instead of discarding a different profile on the same platform", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, creatorPlatformsTable, platformsTable } =
      await import("@/database/schema");
    const { creatorsMergeService } =
      await import("@/modules/creators/creators.merge.service");
    const [platform] = await db
      .insert(platformsTable)
      .values({ name: "Conflicting Platform" })
      .returning();
    const [into] = await db
      .insert(creatorsTable)
      .values({ name: "Conflict Into" })
      .returning();
    const [from] = await db
      .insert(creatorsTable)
      .values({ name: "Conflict From" })
      .returning();
    await db.insert(creatorPlatformsTable).values([
      {
        creatorId: into.id,
        platformId: platform.id,
        username: "canonical",
        profileUrl: "https://example.invalid/canonical",
      },
      {
        creatorId: from.id,
        platformId: platform.id,
        username: "duplicate",
        profileUrl: "https://example.invalid/duplicate",
      },
    ]);

    await expect(
      creatorsMergeService.mergeCreators(from.id, into.id)
    ).rejects.toThrow("resolve that profile before merging");
    expect(
      await db.select().from(creatorsTable).where(eq(creatorsTable.id, from.id))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(creatorPlatformsTable)
        .where(eq(creatorPlatformsTable.creatorId, from.id))
    ).toHaveLength(1);
  });

  it("exposes the authenticated merge endpoint with an API-shaped survivor", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable } = await import("@/database/schema");
    const [into] = await db
      .insert(creatorsTable)
      .values({ name: "HTTP Merge Into" })
      .returning();
    const [from] = await db
      .insert(creatorsTable)
      .values({ name: "HTTP Merge From" })
      .returning();

    const unauthorized = await ctx!.inject({
      method: "POST",
      url: `/api/creators/${from.id}/merge`,
      payload: { into_creator_id: into.id },
    });
    expect(unauthorized.statusCode, unauthorized.body).toBe(401);

    const response = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${from.id}/merge`,
      payload: {
        into_creator_id: into.id,
        reason: "HTTP integration test",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        id: into.id,
        name: "HTTP Merge Into",
        is_favorite: false,
      },
      message: "Creators merged successfully",
    });
    expect(response.json().data.created_at).toBeString();
  });

  it("rejects merging a creator into itself", async () => {
    const { creatorsMergeService } =
      await import("@/modules/creators/creators.merge.service");
    await expect(creatorsMergeService.mergeCreators(1, 1)).rejects.toThrow();
  });
});
