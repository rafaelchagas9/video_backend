import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-triage-tagging-test";
process.env.POSTGRES_PASSWORD ||= "demo-triage-tagging-test";
process.env.SESSION_SECRET ||=
  "demo-triage-tagging-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-triage-tagging-${process.pid}.sqlite`;

describe("demo triage and tagging-rules HTTP contracts", () => {
  const app = Fastify({ logger: false });
  let originalDemoMode: boolean;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;

    const { importDemoJsonFile, setDemoDatabasePathForTests } =
      await import("@/database/demo");
    setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    importDemoJsonFile(undefined, { reset: true });

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: "Triage contract", version: "1" } },
      transform: jsonSchemaTransform,
    });
    const { triageRoutes, usersTriageLegacyRoutes } =
      await import("@/modules/triage/triage.routes");
    const { taggingRulesRoutes } =
      await import("@/modules/tagging-rules/tagging-rules.routes");
    await app.register(triageRoutes, { prefix: "/api/triage" });
    await app.register(usersTriageLegacyRoutes, { prefix: "/api/users" });
    await app.register(taggingRulesRoutes, { prefix: "/api/tagging-rules" });
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

  it("serves canonical and legacy triage routes from demo SQLite", async () => {
    for (const [url, filterKey] of [
      ["/api/triage/progress", "canonical-untagged"],
      ["/api/users/triage-progress", "legacy-untagged"],
    ] as const) {
      const save = await app.inject({
        method: "POST",
        url,
        payload: {
          filterKey,
          lastVideoId: 1,
          processedCount: 1,
          totalCount: 4,
        },
      });
      expect(save.statusCode, `POST ${url}: ${save.body}`).toBe(200);

      const read = await app.inject({
        method: "GET",
        url: `${url}?filterKey=${filterKey}`,
      });
      expect(read.statusCode, `GET ${url}: ${read.body}`).toBe(200);
      expect(read.json().data).toMatchObject({
        filter_key: filterKey,
        last_video_id: 1,
        processed_count: 1,
        total_count: 4,
      });
    }

    for (const url of [
      "/api/triage/bulk-actions",
      "/api/users/triage/bulk-actions",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        payload: { videoIds: [1], actions: { addCreatorIds: [1] } },
      });
      expect(response.statusCode, `POST ${url}: ${response.body}`).toBe(200);
      expect(response.json().data).toMatchObject({ processed: 1, errors: 0 });
    }

    for (const url of ["/api/triage/stats", "/api/users/triage/statistics"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `GET ${url}: ${response.body}`).toBe(200);
      expect(response.json().data).toMatchObject({
        total_videos: 132,
        tagged_percentage: expect.any(Number),
      });
    }
  });

  it("documents validation and assignment conflicts for both triage bulk routes", () => {
    const paths = app.swagger().paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    for (const path of [
      "/api/triage/bulk-actions",
      "/api/users/triage/bulk-actions",
    ]) {
      expect(paths[path]?.post?.responses).toEqual(
        expect.objectContaining({
          "200": expect.anything(),
          "400": expect.anything(),
          "401": expect.anything(),
          "409": expect.anything(),
        })
      );
    }
  });

  it("serves the complete tagging-rule lifecycle from demo SQLite", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/tagging-rules",
      payload: {
        name: "Demo asset rule",
        rule_type: "path_match",
        priority: 50,
        conditions: [
          {
            condition_type: "file_pattern",
            operator: "contains",
            value: ".",
          },
        ],
        actions: [{ action_type: "add_creator", target_id: 1 }],
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const ruleId = create.json().data.id as number;

    const list = await app.inject({ method: "GET", url: "/api/tagging-rules" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const get = await app.inject({
      method: "GET",
      url: `/api/tagging-rules/${ruleId}`,
    });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().data.name).toBe("Demo asset rule");

    const update = await app.inject({
      method: "PATCH",
      url: `/api/tagging-rules/${ruleId}`,
      payload: { description: "Persisted in demo SQLite" },
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json().data.description).toBe("Persisted in demo SQLite");

    const test = await app.inject({
      method: "POST",
      url: `/api/tagging-rules/${ruleId}/test?limit=5`,
    });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json().data.matched).toBeGreaterThan(0);

    const apply = await app.inject({
      method: "POST",
      url: "/api/tagging-rules/apply",
      payload: { video_ids: [1], dry_run: false, limit: 1 },
    });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(apply.json().data).toMatchObject({ processed: 1, errors: 0 });

    const second = await app.inject({
      method: "POST",
      url: "/api/tagging-rules",
      payload: { name: "Delete in bulk", rule_type: "manual" },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().data.id as number;

    const bulkDelete = await app.inject({
      method: "POST",
      url: "/api/tagging-rules/bulk/delete",
      payload: { ids: [secondId] },
    });
    expect(bulkDelete.statusCode, bulkDelete.body).toBe(200);
    expect(bulkDelete.json().data.deleted).toBe(1);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/tagging-rules/${ruleId}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);
    const empty = await app.inject({
      method: "GET",
      url: "/api/tagging-rules",
    });
    expect(empty.json().data).toEqual([]);
  });
});
