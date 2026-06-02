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
      platformsTable,
    } = await import("@/database/schema");
    const { creatorsMergeService } = await import(
      "@/modules/creators/creators.merge.service"
    );

    // --- Arrange ----------------------------------------------------------
    const [platform] = await db
      .insert(platformsTable)
      .values({ name: "OnlyFans", baseUrl: "https://onlyfans.com" })
      .returning();

    const [into] = await db
      .insert(creatorsTable)
      .values({ name: "Canonical Creator" })
      .returning();
    const [from] = await db
      .insert(creatorsTable)
      .values({ name: "Duplicate Creator" })
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

    // Global-unique external id, carried by `from`.
    await db.insert(creatorExternalIdsTable).values({
      creatorId: from.id,
      source: "theporndb",
      externalId: "tpdb-111",
    });

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
        username: "from_handle",
        profileUrl: "https://onlyfans.com/from",
      },
    ]);

    // --- Act --------------------------------------------------------------
    const merged = await creatorsMergeService.mergeCreators(
      from.id,
      into.id,
      "integration test",
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
      ["Duplicate Creator", "From Only", "Into Only", "Shared Alias"].sort(),
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
    expect(externalIds).toHaveLength(1);
    expect(externalIds[0].externalId).toBe("tpdb-111");

    // Platform collision resolved: only `into`'s original profile survives.
    const platforms = await db
      .select()
      .from(creatorPlatformsTable)
      .where(eq(creatorPlatformsTable.creatorId, into.id));
    expect(platforms).toHaveLength(1);
    expect(platforms[0].username).toBe("into_handle");

    // Audit row with snapshot.
    const merges = await db
      .select()
      .from(creatorMergesTable)
      .where(eq(creatorMergesTable.intoCreatorId, into.id));
    expect(merges).toHaveLength(1);
    expect(merges[0].fromCreatorId).toBe(from.id);
    expect(merges[0].fromName).toBe("Duplicate Creator");
    expect(merges[0].reason).toBe("integration test");
    expect(merges[0].snapshot).toMatchObject({ id: from.id, name: "Duplicate Creator" });
  });

  it("rejects merging a creator into itself", async () => {
    const { creatorsMergeService } = await import(
      "@/modules/creators/creators.merge.service"
    );
    await expect(creatorsMergeService.mergeCreators(1, 1)).rejects.toThrow();
  });
});
