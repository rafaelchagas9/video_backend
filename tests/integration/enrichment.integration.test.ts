import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { TestApp } from "../helpers/test-app";
import { createTestApp, seedVideoFixture } from "../helpers/test-app";

/**
 * Exercises the enrichment loop end-to-end through the HTTP API across every entity
 * type: run → store suggestions → list → accept (delegating to existing writers).
 *
 * The Python service is mocked so the test is hermetic (no network). The mock is
 * entity-aware: it returns candidates appropriate to the requested `entity_type`.
 * `mock.module` runs BEFORE `createTestApp()` so the lazily-imported enrichment
 * service binds to the mocked client. The live source path is verified manually.
 */

const CREATOR_CANDIDATES = [
  {
    type: "external_id",
    value: "tpdb-uuid-123",
    source: "theporndb",
    source_url: "https://theporndb.net/performers/tpdb-uuid-123",
    confidence: 0.95,
    raw: { id: "tpdb-uuid-123" },
  },
  { type: "field", field_key: "gender", value: "FEMALE", source: "theporndb", confidence: 0.95 },
  { type: "field", field_key: "height_cm", value: "170", source: "theporndb", confidence: 0.95 },
  { type: "alias", value: "Test Alias", source: "theporndb", confidence: 0.6 },
  {
    type: "social",
    field_key: "Twitter",
    value: "https://x.com/testperformer",
    source: "theporndb",
    source_url: "https://x.com/testperformer",
    confidence: 0.6,
  },
];

const STUDIO_CANDIDATES = [
  { type: "external_id", value: "studio-uuid-1", source: "stashdb", confidence: 0.95, raw: { id: "studio-uuid-1" } },
  { type: "field", field_key: "description", value: "A great studio", source: "stashdb", confidence: 0.9 },
  { type: "alias", value: "Studio Alias", source: "stashdb", confidence: 0.7 },
  {
    type: "social",
    field_key: "Website",
    value: "https://studio.example.com",
    source: "stashdb",
    source_url: "https://studio.example.com",
    confidence: 0.7,
  },
  {
    type: "parent",
    value: "Parent Network",
    source: "stashdb",
    confidence: 0.9,
    raw: { external_id: "parent-uuid-9", source: "stashdb" },
  },
];

const TAG_CANDIDATES = [
  { type: "external_id", value: "tag-uuid-1", source: "stashdb", confidence: 0.95, raw: { id: "tag-uuid-1" } },
  { type: "field", field_key: "description", value: "Tag description", source: "stashdb", confidence: 0.9 },
  { type: "alias", value: "Tag Alias", source: "stashdb", confidence: 0.7 },
  {
    type: "category",
    value: "Position",
    source: "stashdb",
    confidence: 0.8,
    raw: { external_id: "cat-1", group: "Action", source: "stashdb" },
  },
];

const SCENE_CANDIDATES = [
  { type: "external_id", value: "scene-uuid-1", source: "stashdb", confidence: 0.95, raw: { id: "scene-uuid-1" } },
  { type: "field", field_key: "title", value: "Real Scene Title", source: "stashdb", confidence: 0.95 },
  { type: "field", field_key: "description", value: "Scene details", source: "stashdb", confidence: 0.95 },
  { type: "field", field_key: "release_date", value: "2021-05-01", source: "stashdb", confidence: 0.95 },
  {
    type: "performer",
    value: "Scene Performer",
    source: "stashdb",
    confidence: 0.9,
    raw: { external_id: "perf-77", source: "stashdb" },
  },
  {
    type: "studio",
    value: "Scene Studio",
    source: "stashdb",
    confidence: 0.9,
    raw: { external_id: "studio-77", source: "stashdb" },
  },
  {
    type: "tag",
    value: "Scene Tag",
    source: "stashdb",
    confidence: 0.9,
    raw: { external_id: "tag-77", source: "stashdb" },
  },
];

const CANDIDATES_BY_ENTITY: Record<string, unknown[]> = {
  creator: CREATOR_CANDIDATES,
  studio: STUDIO_CANDIDATES,
  tag: TAG_CANDIDATES,
  scene: SCENE_CANDIDATES,
};

const EXACT_ID_CANDIDATES_BY_ENTITY: Record<string, (externalId: string) => unknown[]> = {
  creator: (externalId) => [
    { type: "external_id", value: externalId, source: "stashdb", confidence: 1 },
    { type: "field", field_key: "gender", value: "FEMALE", source: "stashdb", confidence: 1 },
    { type: "alias", value: "Auto Performer Alias", source: "stashdb", confidence: 1 },
  ],
  studio: (externalId) => [
    { type: "external_id", value: externalId, source: "stashdb", confidence: 1 },
    { type: "field", field_key: "description", value: "Auto studio details", source: "stashdb", confidence: 1 },
    { type: "alias", value: "Auto Studio Alias", source: "stashdb", confidence: 1 },
  ],
  tag: (externalId) => [
    { type: "external_id", value: externalId, source: "stashdb", confidence: 1 },
    { type: "field", field_key: "description", value: "Auto tag details", source: "stashdb", confidence: 1 },
    { type: "alias", value: "Auto Tag Alias", source: "stashdb", confidence: 1 },
  ],
};

const enrichmentRequests: Array<{
  entity_type: string;
  name: string;
  sources?: string[];
  limit?: number;
  external_ids?: Array<{ source: string; external_id: string }>;
}> = [];

type Suggestion = {
  id: number;
  type: string;
  field_key: string | null;
  value: string;
};

describe("enrichment loop (all entity types)", () => {
  let ctx: TestApp | undefined;

  beforeAll(async () => {
    mock.module("@/modules/enrichment/enrichment.client", () => ({
      getEnrichmentClient: () => ({
        enrich: async (req: {
          entity_type: string;
          name: string;
          sources?: string[];
          limit?: number;
          external_ids?: Array<{ source: string; external_id: string }>;
        }) => {
          enrichmentRequests.push(req);
          return {
            candidates: req.external_ids?.[0]
              ? EXACT_ID_CANDIDATES_BY_ENTITY[req.entity_type]?.(
                  req.external_ids[0].external_id,
                ) ?? []
              : CANDIDATES_BY_ENTITY[req.entity_type] ?? [],
            sources_used: req.external_ids?.[0]
              ? [req.external_ids[0].source]
              : (req.sources ?? ["stashdb"]),
            errors: [],
          };
        },
        healthCheck: async () => ({ status: "healthy" }),
      }),
      resetEnrichmentClient: () => {},
    }));

    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function runAndList(
    entityType: string,
    entityId: number,
    expectedCount: number,
  ): Promise<{ suggestions: Suggestion[]; pick: (t: string, key?: string) => Suggestion }> {
    const runRes = await ctx!.authInject({
      method: "POST",
      url: `/api/enrichment/${entityType}/${entityId}/run`,
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().data.status).toBe("success");
    expect(runRes.json().data.suggestion_count).toBe(expectedCount);

    const listRes = await ctx!.authInject({
      method: "GET",
      url: `/api/enrichment/suggestions?entity_type=${entityType}&entity_id=${entityId}`,
    });
    expect(listRes.statusCode).toBe(200);
    const suggestions = listRes.json().data as Suggestion[];
    expect(suggestions).toHaveLength(expectedCount);

    const pick = (t: string, key?: string) =>
      suggestions.find((s) => s.type === t && (!key || s.field_key === key))!;
    return { suggestions, pick };
  }

  async function accept(id: number): Promise<void> {
    const res = await ctx!.authInject({
      method: "POST",
      url: `/api/enrichment/suggestions/${id}/accept`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("accepted");
  }

  it("passes scan options to the enrichment service", async () => {
    const created = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Sabrina Carpenter" },
    });
    expect(created.statusCode).toBe(201);
    const creatorId = created.json().data.id as number;

    const runRes = await ctx!.authInject({
      method: "POST",
      url: `/api/enrichment/creator/${creatorId}/run`,
      payload: {
        sources: ["theporndb", "stashdb"],
        search_name: "Brina",
        limit: 7,
      },
    });

    expect(runRes.statusCode).toBe(200);
    const latestRequest = enrichmentRequests.at(-1)!;
    expect(latestRequest.entity_type).toBe("creator");
    expect(latestRequest.name).toBe("Brina");
    expect(latestRequest.sources).toEqual(["theporndb", "stashdb"]);
    expect(latestRequest.limit).toBe(7);
    expect(runRes.json().data.sources_used).toEqual(["theporndb", "stashdb"]);
  });

  it("creator: runs, stores, accepts and rejects", async () => {
    const created = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Test Performer" },
    });
    expect(created.statusCode).toBe(201);
    const creatorId = created.json().data.id as number;

    const { pick } = await runAndList("creator", creatorId, CREATOR_CANDIDATES.length);

    await accept(pick("field", "gender").id);
    await accept(pick("external_id").id);
    await accept(pick("alias").id);
    await accept(pick("social").id);

    const rejectRes = await ctx!.authInject({
      method: "POST",
      url: `/api/enrichment/suggestions/${pick("field", "height_cm").id}/reject`,
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().data.status).toBe("rejected");

    const { db } = await import("@/config/drizzle");
    const { creatorsTable, creatorExternalIdsTable, creatorAliasesTable, creatorSocialLinksTable } =
      await import("@/database/schema");

    const [creator] = await db.select().from(creatorsTable).where(eq(creatorsTable.id, creatorId));
    expect(creator.gender).toBe("FEMALE");
    expect(creator.heightCm).toBeNull();

    const externalIds = await db
      .select()
      .from(creatorExternalIdsTable)
      .where(eq(creatorExternalIdsTable.creatorId, creatorId));
    expect(externalIds[0].externalId).toBe("tpdb-uuid-123");

    const aliases = await db
      .select()
      .from(creatorAliasesTable)
      .where(eq(creatorAliasesTable.creatorId, creatorId));
    expect(aliases.map((a) => a.name)).toContain("Test Alias");

    const socials = await db
      .select()
      .from(creatorSocialLinksTable)
      .where(eq(creatorSocialLinksTable.creatorId, creatorId));
    expect(socials[0].url).toBe("https://x.com/testperformer");
  });

  it("studio: accepts description, alias, social, external id and parent", async () => {
    const { db } = await import("@/config/drizzle");
    const { studiosTable, studioAliasesTable, studioExternalIdsTable, studioSocialLinksTable } =
      await import("@/database/schema");

    const [studio] = await db
      .insert(studiosTable)
      .values({ name: "Enrich Studio" })
      .returning({ id: studiosTable.id });
    const studioId = studio.id;

    const { pick } = await runAndList("studio", studioId, STUDIO_CANDIDATES.length);
    await accept(pick("field", "description").id);
    await accept(pick("alias").id);
    await accept(pick("social").id);
    await accept(pick("external_id").id);
    await accept(pick("parent").id);

    const [updated] = await db.select().from(studiosTable).where(eq(studiosTable.id, studioId));
    expect(updated.description).toBe("A great studio");
    expect(updated.parentStudioId).not.toBeNull();

    const [parent] = await db
      .select()
      .from(studiosTable)
      .where(eq(studiosTable.id, updated.parentStudioId!));
    expect(parent.name).toBe("Parent Network");

    const aliases = await db
      .select()
      .from(studioAliasesTable)
      .where(eq(studioAliasesTable.studioId, studioId));
    expect(aliases.map((a) => a.name)).toContain("Studio Alias");

    const externalIds = await db
      .select()
      .from(studioExternalIdsTable)
      .where(eq(studioExternalIdsTable.studioId, studioId));
    expect(externalIds[0].externalId).toBe("studio-uuid-1");

    const socials = await db
      .select()
      .from(studioSocialLinksTable)
      .where(eq(studioSocialLinksTable.studioId, studioId));
    expect(socials[0].url).toBe("https://studio.example.com");
  });

  it("tag: accepts description, alias, external id and category", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable, tagAliasesTable, tagExternalIdsTable, tagCategoriesTable } =
      await import("@/database/schema");

    const [tag] = await db
      .insert(tagsTable)
      .values({ name: "Enrich Tag" })
      .returning({ id: tagsTable.id });
    const tagId = tag.id;

    const { pick } = await runAndList("tag", tagId, TAG_CANDIDATES.length);
    await accept(pick("field", "description").id);
    await accept(pick("alias").id);
    await accept(pick("external_id").id);
    await accept(pick("category").id);

    const [updated] = await db.select().from(tagsTable).where(eq(tagsTable.id, tagId));
    expect(updated.description).toBe("Tag description");
    expect(updated.categoryId).not.toBeNull();

    const [category] = await db
      .select()
      .from(tagCategoriesTable)
      .where(eq(tagCategoriesTable.id, updated.categoryId!));
    expect(category.name).toBe("Position");
    expect(category.group).toBe("Action");

    const aliases = await db
      .select()
      .from(tagAliasesTable)
      .where(eq(tagAliasesTable.tagId, tagId));
    expect(aliases.map((a) => a.name)).toContain("Tag Alias");

    const externalIds = await db
      .select()
      .from(tagExternalIdsTable)
      .where(eq(tagExternalIdsTable.tagId, tagId));
    expect(externalIds[0].externalId).toBe("tag-uuid-1");
  });

  it("scene: accepts fields and links performer/studio/tag (creating missing)", async () => {
    const { videoId } = await seedVideoFixture();

    const { pick } = await runAndList("scene", videoId, SCENE_CANDIDATES.length);
    await accept(pick("field", "title").id);
    await accept(pick("field", "description").id);
    await accept(pick("field", "release_date").id);
    await accept(pick("external_id").id);
    await accept(pick("performer").id);
    await accept(pick("studio").id);
    await accept(pick("tag").id);

    const { db } = await import("@/config/drizzle");
    const {
      videosTable,
      videoMetadataTable,
      videoExternalIdsTable,
      videoCreatorsTable,
      videoStudiosTable,
      videoTagsTable,
      creatorsTable,
      creatorAliasesTable,
      creatorExternalIdsTable,
      studiosTable,
      studioAliasesTable,
      studioExternalIdsTable,
      tagsTable,
      tagAliasesTable,
      tagExternalIdsTable,
    } = await import("@/database/schema");

    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
    expect(video.title).toBe("Real Scene Title");
    expect(video.description).toBe("Scene details");

    const [releaseDate] = await db
      .select()
      .from(videoMetadataTable)
      .where(and(eq(videoMetadataTable.videoId, videoId), eq(videoMetadataTable.key, "release_date")));
    expect(releaseDate.value).toBe("2021-05-01");

    const externalIds = await db
      .select()
      .from(videoExternalIdsTable)
      .where(eq(videoExternalIdsTable.videoId, videoId));
    expect(externalIds[0].externalId).toBe("scene-uuid-1");

    // Performer was created and linked.
    const links = await db
      .select()
      .from(videoCreatorsTable)
      .where(eq(videoCreatorsTable.videoId, videoId));
    expect(links).toHaveLength(1);
    const [performer] = await db
      .select()
      .from(creatorsTable)
      .where(eq(creatorsTable.id, links[0].creatorId));
    expect(performer.name).toBe("Scene Performer");
    expect(performer.gender).toBe("FEMALE");

    const performerAliases = await db
      .select()
      .from(creatorAliasesTable)
      .where(eq(creatorAliasesTable.creatorId, performer.id));
    expect(performerAliases.map((a) => a.name)).toContain("Auto Performer Alias");

    const performerExternalIds = await db
      .select()
      .from(creatorExternalIdsTable)
      .where(eq(creatorExternalIdsTable.creatorId, performer.id));
    expect(performerExternalIds.map((e) => e.externalId)).toContain("perf-77");

    // Studio was created and linked.
    const studioLinks = await db
      .select()
      .from(videoStudiosTable)
      .where(eq(videoStudiosTable.videoId, videoId));
    expect(studioLinks).toHaveLength(1);
    const [studio] = await db
      .select()
      .from(studiosTable)
      .where(eq(studiosTable.id, studioLinks[0].studioId));
    expect(studio.name).toBe("Scene Studio");
    expect(studio.description).toBe("Auto studio details");

    const studioAliases = await db
      .select()
      .from(studioAliasesTable)
      .where(eq(studioAliasesTable.studioId, studio.id));
    expect(studioAliases.map((a) => a.name)).toContain("Auto Studio Alias");

    const studioExternalIds = await db
      .select()
      .from(studioExternalIdsTable)
      .where(eq(studioExternalIdsTable.studioId, studio.id));
    expect(studioExternalIds.map((e) => e.externalId)).toContain("studio-77");

    // Tag was created and linked.
    const tagLinks = await db
      .select()
      .from(videoTagsTable)
      .where(eq(videoTagsTable.videoId, videoId));
    expect(tagLinks).toHaveLength(1);
    const [tag] = await db.select().from(tagsTable).where(eq(tagsTable.id, tagLinks[0].tagId));
    expect(tag.name).toBe("Scene Tag");
    expect(tag.description).toBe("Auto tag details");

    const tagAliases = await db
      .select()
      .from(tagAliasesTable)
      .where(eq(tagAliasesTable.tagId, tag.id));
    expect(tagAliases.map((a) => a.name)).toContain("Auto Tag Alias");

    const tagExternalIds = await db
      .select()
      .from(tagExternalIdsTable)
      .where(eq(tagExternalIdsTable.tagId, tag.id));
    expect(tagExternalIds.map((e) => e.externalId)).toContain("tag-77");
  });
});
