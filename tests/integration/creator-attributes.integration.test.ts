import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createTestApp,
  seedVideoFixture,
  type TestApp,
} from "../helpers/test-app";
import {
  creatorFilterContract,
  creatorFilterFixtures,
} from "../helpers/creator-filter-contract";

describe("creator filters and facets in disposable PostgreSQL", () => {
  let ctx: TestApp | undefined;
  beforeAll(async () => {
    ctx = await createTestApp();
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, creatorExternalIdsTable } =
      await import("@/database/schema");
    for (const fixture of creatorFilterFixtures) {
      const row: Record<string, any> = {};
      for (const [key, value] of Object.entries(fixture))
        if (key !== "external_ids")
          row[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] =
            value;
      const [creator] = await db
        .insert(creatorsTable)
        .values(row as typeof creatorsTable.$inferInsert)
        .returning();
      if (fixture.external_ids)
        await db
          .insert(creatorExternalIdsTable)
          .values(
            fixture.external_ids.map((identity: any) => ({
              creatorId: creator!.id,
              source: identity.source,
              externalId: identity.external_id,
            }))
          );
    }
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  creatorFilterContract((query, facets) =>
    ctx!.authInject({
      method: "GET",
      url: `/api/creators${facets ? "/facets" : ""}?search=Facet%20Fixture&${query}`,
    })
  );
  it("combines accepted attributes with aliases, favorites, studios and completeness", async () => {
    const { db } = await import("@/config/drizzle");
    const schema = await import("@/database/schema");
    const { creatorsService } =
      await import("@/modules/creators/creators.service");
    const [creator] = await db
      .insert(schema.creatorsTable)
      .values({ name: "Relationship Creator", country: "USA", heightCm: 174 })
      .returning();
    const [studio] = await db
      .insert(schema.studiosTable)
      .values({ name: "Relationship Studio" })
      .returning();
    const [platform] = await db
      .insert(schema.platformsTable)
      .values({ name: "Relationship Platform" })
      .returning();
    const { videoId } = await seedVideoFixture(
      "creator-filter-relationship.mp4"
    );
    await db
      .insert(schema.creatorStudiosTable)
      .values({ creatorId: creator!.id, studioId: studio!.id });
    await db
      .insert(schema.videoCreatorsTable)
      .values({ creatorId: creator!.id, videoId });
    await db
      .insert(schema.creatorFavoritesTable)
      .values({ creatorId: creator!.id, userId: ctx!.userId });
    await db
      .insert(schema.creatorAliasesTable)
      .values({ creatorId: creator!.id, name: "Unique.(Alias)" });
    await db
      .insert(schema.creatorGalleryMediaTable)
      .values({
        creatorId: creator!.id,
        filePath: "/tmp/fixture-picture.jpg",
        isProfilePicture: true,
      });
    await db
      .insert(schema.creatorPlatformsTable)
      .values({
        creatorId: creator!.id,
        platformId: platform!.id,
        username: "UniqueHandle",
        profileUrl: "https://example.test/UniqueHandle",
      });
    for (const search of ["Unique.(Alias)", "UniqueHandle"]) {
      const query = `search=${encodeURIComponent(search)}&country=United%20States&isFavorite=true&hasProfilePicture=true&complete=true&minVideoCount=1&maxVideoCount=1&studioIds=${studio!.id}`;
      const list = await ctx!.authInject({
        method: "GET",
        url: `/api/creators?${query}`,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().pagination.total).toBe(1);
      expect(list.json().data[0]).toMatchObject({
        id: creator!.id,
        is_favorite: true,
        completeness: { is_complete: true },
      });
      const facets = await ctx!.authInject({
        method: "GET",
        url: `/api/creators/facets?${query}`,
      });
      expect(facets.statusCode, facets.body).toBe(200);
      expect(facets.json().data.total).toBe(1);
      expect(facets.json().data.facets.heightCm.min).toBe(174);
    }
    expect(
      (
        await creatorsService.facets(
          { search: "Relationship Creator", isFavorite: true },
          ctx!.userId + 999
        )
      ).total
    ).toBe(0);
    expect(
      (
        await creatorsService.list(
          { search: "Relationship Creator", isFavorite: false },
          ctx!.userId
        )
      ).pagination.total
    ).toBe(0);
    expect(
      (
        await creatorsService.facets(
          { search: "Relationship Creator", isFavorite: false },
          ctx!.userId + 999
        )
      ).total
    ).toBe(1);
  });
  it("safely handles corrupt dates and preserves source facts", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable } = await import("@/database/schema");
    const { creatorsService } =
      await import("@/modules/creators/creators.service");
    for (const [index, birthDate] of [
      "0000-01-01",
      "2000-00-01",
      "2000-13-01",
      "2000-01-00",
      "2000-01-32",
      "2001-02-29",
      "2000-04-31",
      "abc",
      "9999-12-31",
    ].entries()) {
      await db
        .insert(creatorsTable)
        .values({ name: `Broken Date ${index}`, birthDate });
    }
    const facets = await creatorsService.facets(
      { search: "Broken Date" },
      ctx!.userId
    );
    expect(facets.facets.age).toEqual({
      type: "range",
      min: null,
      max: null,
      knownCount: 0,
      unknownCount: 9,
    });
    const { eq } = await import("drizzle-orm");
    const [alpha] = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.name, "Facet Fixture Alpha"));
    expect(alpha).toMatchObject({
      country: "US",
      hairColor: "BLOND",
      ethnicity: "LATINA",
    });
  });
  it("requires authentication for facet access", async () => {
    const response = await ctx!.inject({
      method: "GET",
      url: "/api/creators/facets",
    });
    expect(response.statusCode).toBe(401);
  });
});
