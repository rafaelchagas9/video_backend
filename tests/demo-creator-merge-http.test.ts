import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-creator-merge-test";
process.env.POSTGRES_PASSWORD ||= "demo-creator-merge-test";
process.env.SESSION_SECRET ||=
  "demo-creator-merge-test-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-creator-merge-${process.pid}.sqlite`;

describe("demo creator merge HTTP contract", () => {
  const app = Fastify({ logger: false });
  let originalDemoMode: boolean;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    demo.importDemoJsonFile(undefined, { reset: true });

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      const httpError = error as { statusCode?: number; message?: string };
      const statusCode =
        typeof httpError.statusCode === "number" ? httpError.statusCode : 500;
      return reply.status(statusCode).send({
        success: false,
        error: {
          message: httpError.message ?? "Internal server error",
          statusCode,
        },
      });
    });
    const { creatorsRoutes } =
      await import("@/modules/creators/creators.routes");
    await app.register(creatorsRoutes, { prefix: "/api/creators" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const { setDemoDatabasePathForTests } = await import("@/database/demo");
    setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  async function createCreator(name: string, description?: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/creators",
      payload: { name, description },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data as { id: number; name: string };
  }

  it("atomically moves every demo reference and keeps a recoverable audit", async () => {
    const { demoRepository, getDemoSqlite } = await import("@/database/demo");
    const sqlite = getDemoSqlite();
    const target = await createCreator("Merge Target");
    const source = await createCreator("Merge Source", "Source description");
    const timestamp = new Date().toISOString();
    const videoIds = (
      sqlite
        .query("SELECT id FROM demo_videos ORDER BY id LIMIT 2")
        .all() as Array<{
        id: number;
      }>
    ).map((row) => row.id);
    const studioId = (
      sqlite.query("SELECT id FROM demo_studios ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;

    sqlite
      .query(
        "INSERT INTO demo_video_creators (video_id,creator_id) VALUES (?,?),(?,?),(?,?)"
      )
      .run(
        videoIds[0],
        target.id,
        videoIds[0],
        source.id,
        videoIds[1],
        source.id
      );
    sqlite
      .query(
        "INSERT INTO demo_creator_studios (creator_id,studio_id) VALUES (?,?)"
      )
      .run(source.id, studioId);
    sqlite
      .query(
        "INSERT INTO demo_creator_favorites (user_id,creator_id,added_at) VALUES (1,?,?)"
      )
      .run(source.id, timestamp);
    sqlite
      .query(
        "INSERT INTO demo_creator_aliases (id,creator_id,name,note,created_at) VALUES (1,?,?,NULL,?),(1,?,?,NULL,?)"
      )
      .run(
        target.id,
        "Target Alias",
        timestamp,
        source.id,
        "Source Alias",
        timestamp
      );
    sqlite
      .query(
        `INSERT INTO demo_creator_platforms
          (id,creator_id,platform_id,platform_name,username,profile_url,is_primary,created_at,updated_at)
         VALUES (1,?,101,'Target Site','target','https://example.invalid/target',1,?,?),
                (1,?,102,'Source Site','source','https://example.invalid/source',1,?,?)`
      )
      .run(target.id, timestamp, timestamp, source.id, timestamp, timestamp);
    sqlite
      .query(
        "INSERT INTO demo_creator_social_links (id,creator_id,platform_name,url,created_at) VALUES (1,?,'Target','https://example.invalid/t',?),(1,?,'Source','https://example.invalid/s',?)"
      )
      .run(target.id, timestamp, source.id, timestamp);
    sqlite
      .query(
        `INSERT INTO demo_creator_gallery
          (id,creator_id,label,description,file_path,is_profile_picture,is_main_picture,created_at,updated_at)
         VALUES (1,?,'target',NULL,'demo_mode/artwork/manifest.json',1,1,?,?),
                (1,?,'source',NULL,'demo_mode/generate_media.ts',1,1,?,?)`
      )
      .run(target.id, timestamp, timestamp, source.id, timestamp, timestamp);
    sqlite
      .query(
        "INSERT INTO demo_creator_face_embeddings (id,creator_id,payload_json,thumbnail_path,is_primary) VALUES (1,?,'{}',NULL,1),(1,?,'{}',NULL,1)"
      )
      .run(target.id, source.id);
    sqlite
      .query(
        `INSERT INTO demo_enrichment_suggestions
          (id,entity_type,entity_id,type,field_key,value,source,source_url,confidence,face_match_score,cached_preview_path,status,dedup_hash,raw_json,created_at,updated_at)
         VALUES (99001,'creator',?,'alias',NULL,'Suggested Alias','stashdb',NULL,0.9,NULL,NULL,'pending','merge-source-hash',NULL,?,?)`
      )
      .run(source.id, timestamp, timestamp);
    sqlite
      .query(
        `INSERT INTO demo_enrichment_runs
          (entity_type,entity_id,status,sources_used_json,suggestion_count,errors_json,started_at,finished_at)
         VALUES ('creator',?,'success','["stashdb"]',1,NULL,?,?)`
      )
      .run(source.id, timestamp, timestamp);
    demoRepository.putResource("face-embedding", 99001, {
      id: 99001,
      creatorId: source.id,
      isPrimary: true,
    });
    demoRepository.putResource("face-detection", 99001, {
      id: 99001,
      videoId: videoIds[1],
      matchedCreatorId: source.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/creators/${source.id}/merge`,
      payload: {
        into_creator_id: target.id,
        reason: "Demo duplicate review",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        id: target.id,
        name: "Merge Target",
        description: "Source description",
      },
      message: "Creators merged successfully",
    });

    expect(
      sqlite.query("SELECT id FROM demo_creators WHERE id = ?").get(source.id)
    ).toBeNull();
    for (const table of [
      "demo_video_creators",
      "demo_creator_studios",
      "demo_creator_favorites",
      "demo_creator_aliases",
      "demo_creator_platforms",
      "demo_creator_social_links",
      "demo_creator_gallery",
      "demo_creator_face_embeddings",
    ]) {
      const row = sqlite
        .query(`SELECT COUNT(*) AS count FROM ${table} WHERE creator_id = ?`)
        .get(source.id) as { count: number };
      expect(Number(row.count), table).toBe(0);
    }
    expect(
      sqlite
        .query(
          "SELECT COUNT(*) AS count FROM demo_video_creators WHERE creator_id = ?"
        )
        .get(target.id)
    ).toEqual({ count: 2 });
    expect(
      sqlite
        .query(
          "SELECT name FROM demo_creator_aliases WHERE creator_id = ? ORDER BY name"
        )
        .all(target.id)
    ).toEqual([
      { name: "Merge Source" },
      { name: "Source Alias" },
      { name: "Target Alias" },
    ]);
    expect(
      sqlite
        .query(
          "SELECT COUNT(*) AS count FROM demo_creator_gallery WHERE creator_id = ? AND is_profile_picture = 1"
        )
        .get(target.id)
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .query(
          "SELECT COUNT(*) AS count FROM demo_creator_face_embeddings WHERE creator_id = ? AND is_primary = 1"
        )
        .get(target.id)
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .query(
          "SELECT entity_id FROM demo_enrichment_suggestions WHERE id = 99001"
        )
        .get()
    ).toEqual({ entity_id: target.id });
    expect(demoRepository.getResource("face-embedding", 99001)).toMatchObject({
      creatorId: target.id,
    });
    expect(demoRepository.getResource("face-detection", 99001)).toMatchObject({
      matchedCreatorId: target.id,
    });
    expect(
      demoRepository
        .listResources("creator-merge")
        .find((item) => Number(item.fromCreatorId) === source.id)
    ).toMatchObject({
      version: 2,
      intoCreatorId: target.id,
      reason: "Demo duplicate review",
    });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // Retrying the same request is safe and resolves to the same survivor.
    const retry = await app.inject({
      method: "POST",
      url: `/api/creators/${source.id}/merge`,
      payload: { into_creator_id: target.id },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().data.id).toBe(target.id);
  });

  it("rejects ambiguous platform conflicts without changing either creator", async () => {
    const { getDemoSqlite } = await import("@/database/demo");
    const sqlite = getDemoSqlite();
    const target = await createCreator("Conflict Target");
    const source = await createCreator("Conflict Source");
    const timestamp = new Date().toISOString();
    sqlite
      .query(
        `INSERT INTO demo_creator_platforms
          (id,creator_id,platform_id,platform_name,username,profile_url,is_primary,created_at,updated_at)
         VALUES (1,?,201,'Shared','target','https://example.invalid/target',0,?,?),
                (1,?,201,'Shared','source','https://example.invalid/source',0,?,?)`
      )
      .run(target.id, timestamp, timestamp, source.id, timestamp, timestamp);

    const response = await app.inject({
      method: "POST",
      url: `/api/creators/${source.id}/merge`,
      payload: { into_creator_id: target.id },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(
      sqlite
        .query("SELECT COUNT(*) AS count FROM demo_creators WHERE id IN (?, ?)")
        .get(source.id, target.id)
    ).toEqual({ count: 2 });
    expect(
      sqlite
        .query(
          "SELECT COUNT(*) AS count FROM demo_creator_platforms WHERE creator_id IN (?, ?)"
        )
        .get(source.id, target.id)
    ).toEqual({ count: 2 });
  });

  it("rolls back every move and the audit when deletion fails", async () => {
    const { demoRepository, getDemoSqlite } = await import("@/database/demo");
    const sqlite = getDemoSqlite();
    const target = await createCreator("Rollback Target");
    const source = await createCreator("Rollback Source");
    const timestamp = new Date().toISOString();
    const videoId = (
      sqlite.query("SELECT id FROM demo_videos ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;
    sqlite
      .query(
        "INSERT INTO demo_video_creators (video_id,creator_id) VALUES (?,?)"
      )
      .run(videoId, source.id);
    sqlite
      .query(
        "INSERT INTO demo_creator_aliases (id,creator_id,name,note,created_at) VALUES (1,?,?,NULL,?)"
      )
      .run(source.id, "Rollback Alias", timestamp);
    const auditsBefore = demoRepository.listResources("creator-merge").length;

    sqlite.exec(`
      CREATE TRIGGER fail_creator_merge_delete
      BEFORE DELETE ON demo_creators
      WHEN OLD.id = ${source.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced merge rollback');
      END;
    `);
    const response = await app.inject({
      method: "POST",
      url: `/api/creators/${source.id}/merge`,
      payload: { into_creator_id: target.id },
    });
    sqlite.exec("DROP TRIGGER fail_creator_merge_delete");

    expect(response.statusCode, response.body).toBe(500);
    expect(
      sqlite.query("SELECT id FROM demo_creators WHERE id = ?").get(source.id)
    ).toEqual({ id: source.id });
    expect(
      sqlite
        .query(
          "SELECT creator_id FROM demo_video_creators WHERE video_id = ? AND creator_id = ?"
        )
        .get(videoId, source.id)
    ).toEqual({ creator_id: source.id });
    expect(
      sqlite
        .query(
          "SELECT creator_id FROM demo_creator_aliases WHERE creator_id = ? AND name = 'Rollback Alias'"
        )
        .get(source.id)
    ).toEqual({ creator_id: source.id });
    expect(demoRepository.listResources("creator-merge")).toHaveLength(
      auditsBefore
    );
  });

  it("validates self-merges and missing creators before writing", async () => {
    const creator = await createCreator("Validation Creator");
    const self = await app.inject({
      method: "POST",
      url: `/api/creators/${creator.id}/merge`,
      payload: { into_creator_id: creator.id },
    });
    expect(self.statusCode, self.body).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/creators/999999/merge",
      payload: { into_creator_id: creator.id },
    });
    expect(missing.statusCode, missing.body).toBe(404);
  });
});
