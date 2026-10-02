import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  creatorFilterContract,
  creatorFilterFixtures,
} from "./helpers/creator-filter-contract";
import { isDemoRequestAllowed } from "@/utils/demo-mode-policy";

const databasePath = `/tmp/creator-attributes-${process.pid}.sqlite`;
describe("creator filters and facets in isolated demo SQLite", () => {
  const app = Fastify({ logger: false });
  let originalDemoMode: boolean;
  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    demo.importDemoJsonFile(undefined, { reset: true });
    const sqlite = demo.getDemoSqlite();
    for (const fixture of creatorFilterFixtures) {
      sqlite
        .query(
          "INSERT INTO demo_creators (name, extra_json, created_at, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run(
          fixture.name,
          JSON.stringify(fixture),
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:00:00Z"
        );
    }
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: "Creator filters", version: "1" } },
      transform: jsonSchemaTransform,
    });
    const { creatorsRoutes } =
      await import("@/modules/creators/creators.routes");
    await app.register(creatorsRoutes, { prefix: "/api/creators" });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(null);
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(databasePath + suffix, { force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });
  creatorFilterContract((query, facets) =>
    app.inject({
      method: "GET",
      url: `/api/creators${facets ? "/facets" : ""}?search=Facet%20Fixture&${query}`,
    })
  );
  it("combines attributes with demo relationships and scopes favorites to the user", async () => {
    const { getDemoSqlite, demoRepository } = await import("@/database/demo");
    const sqlite = getDemoSqlite();
    const now = "2026-01-01T00:00:00Z";
    const creator = sqlite
      .query(
        "INSERT INTO demo_creators (name, extra_json, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id"
      )
      .get(
        "Relationship Creator",
        JSON.stringify({ country: "USA", height_cm: 174 }),
        now,
        now
      ) as { id: number };
    const studio = sqlite
      .query("SELECT id FROM demo_studios LIMIT 1")
      .get() as { id: number };
    const video = sqlite.query("SELECT id FROM demo_videos LIMIT 1").get() as {
      id: number;
    };
    sqlite
      .query(
        "INSERT INTO demo_creator_studios (creator_id,studio_id) VALUES (?,?)"
      )
      .run(creator.id, studio.id);
    sqlite
      .query(
        "INSERT INTO demo_video_creators (creator_id,video_id) VALUES (?,?)"
      )
      .run(creator.id, video.id);
    sqlite
      .query(
        "INSERT INTO demo_creator_favorites (creator_id,user_id,added_at) VALUES (?,1,?)"
      )
      .run(creator.id, now);
    sqlite
      .query(
        "INSERT INTO demo_creator_aliases (id,creator_id,name,created_at) VALUES (1,?,?,?)"
      )
      .run(creator.id, "Unique.(Alias)", now);
    sqlite
      .query(
        "INSERT INTO demo_creator_gallery (id,creator_id,file_path,is_profile_picture,is_main_picture,created_at,updated_at) VALUES (1,?,?,1,0,?,?)"
      )
      .run(creator.id, "/tmp/fixture.jpg", now, now);
    sqlite
      .query(
        "INSERT INTO demo_creator_social_links (id,creator_id,platform_name,url,created_at) VALUES (1,?,'Example','https://example.test',?)"
      )
      .run(creator.id, now);
    const query = `search=Unique.%28Alias%29&country=US&isFavorite=true&hasProfilePicture=true&complete=true&minVideoCount=1&maxVideoCount=1&studioIds=${studio.id}`;
    const list = await app.inject({
      method: "GET",
      url: `/api/creators?${query}`,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().pagination.total).toBe(1);
    expect(list.json().data[0]).toMatchObject({
      id: creator.id,
      is_favorite: true,
      completeness: { is_complete: true },
    });
    const facets = await app.inject({
      method: "GET",
      url: `/api/creators/facets?${query}`,
    });
    expect(facets.statusCode, facets.body).toBe(200);
    expect(facets.json().data.total).toBe(1);
    expect(facets.json().data.facets.heightCm.min).toBe(174);
    expect(
      demoRepository.getCreatorFacets(
        { search: "Relationship Creator", isFavorite: true },
        999
      ).total
    ).toBe(0);
    expect(
      demoRepository.getCreators(
        { search: "Relationship Creator", isFavorite: false },
        1
      ).pagination.total
    ).toBe(0);
    expect(
      demoRepository.getCreatorFacets(
        { search: "Relationship Creator", isFavorite: false },
        999
      ).total
    ).toBe(1);
  });
  it("documents facets in OpenAPI and permits only the audited demo route", () => {
    expect(app.swagger().paths?.["/api/creators/facets"]?.get).toBeDefined();
    expect(isDemoRequestAllowed("GET", "/api/creators/facets")).toBe(true);
    expect(isDemoRequestAllowed("POST", "/api/creators/facets")).toBe(false);
  });
});
