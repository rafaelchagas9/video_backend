import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-people-http-test";
process.env.POSTGRES_PASSWORD ||= "demo-people-http-test";
process.env.SESSION_SECRET ||=
  "demo-people-http-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-people-http-${process.pid}.sqlite`;

describe("demo people and relationship HTTP contracts", () => {
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
    ])
      rmSync(path, { force: true });
    demo.importDemoJsonFile(undefined, { reset: true });

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const { creatorsRoutes } =
      await import("@/modules/creators/creators.routes");
    const { studiosRoutes } = await import("@/modules/studios/studios.routes");
    await app.register(creatorsRoutes, { prefix: "/api/creators" });
    await app.register(studiosRoutes, { prefix: "/api/studios" });
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
    ])
      rmSync(path, { force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  it("imports creators and studios in bulk without PostgreSQL or remote media", async () => {
    const creators = await app.inject({
      method: "POST",
      url: "/api/creators/bulk?dry_run=false",
      payload: {
        mode: "merge",
        items: [
          {
            name: "Bulk SQLite Creator",
            description: "Created by the demo bulk adapter",
            platforms: [
              {
                platform_id: 77,
                username: "bulk",
                profile_url: "https://example.invalid/bulk",
              },
            ],
            social_links: [
              {
                platform_name: "Website",
                url: "https://example.invalid/creator",
              },
            ],
            aliases: [{ name: "Bulk Alias" }],
            link_video_ids: [128],
          },
        ],
      },
    });
    expect(creators.statusCode, creators.body).toBe(200);
    expect(creators.json().data).toMatchObject({
      dry_run: false,
      summary: { will_create: 1, will_update: 0, errors: 0 },
    });
    const creatorId = creators.json().data.items[0].resolved_id as number;
    expect(creatorId).toBeGreaterThan(42);

    const studios = await app.inject({
      method: "POST",
      url: "/api/studios/bulk?dry_run=false",
      payload: {
        mode: "merge",
        items: [
          {
            name: "Bulk SQLite Studio",
            description: "Created by the demo bulk adapter",
            social_links: [
              {
                platform_name: "Website",
                url: "https://example.invalid/studio",
              },
            ],
            link_creator_ids: [creatorId],
            link_video_ids: [128],
          },
        ],
      },
    });
    expect(studios.statusCode, studios.body).toBe(200);
    expect(studios.json().data).toMatchObject({
      dry_run: false,
      summary: { will_create: 1, will_update: 0, errors: 0 },
    });
    expect(studios.json().data.items[0].resolved_id).toBeGreaterThan(21);
  });

  it("serves creator platform, social, alias, and studio relationships", async () => {
    const creatorResponse = await app.inject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "HTTP Relationship Creator" },
    });
    const studioResponse = await app.inject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "HTTP Relationship Studio" },
    });
    expect(creatorResponse.statusCode, creatorResponse.body).toBe(201);
    expect(studioResponse.statusCode, studioResponse.body).toBe(201);
    const creatorId = creatorResponse.json().data.id as number;
    const studioId = studioResponse.json().data.id as number;

    const platform = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/platforms`,
      payload: {
        platform_id: 91,
        username: "http-user",
        profile_url: "https://example.invalid/profile",
      },
    });
    expect(platform.statusCode, platform.body).toBe(201);
    const platformId = platform.json().data.id as number;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/creators/${creatorId}/platforms`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/creators/${creatorId}/platforms/${platformId}`,
          payload: { username: "updated-user" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/creators/${creatorId}/platforms/${platformId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/creators/${creatorId}/platforms/bulk`,
          payload: {
            items: [
              {
                platform_id: 92,
                username: "bulk-user",
                profile_url: "https://example.invalid/bulk-profile",
              },
            ],
          },
        })
      ).statusCode
    ).toBe(200);

    const social = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/social-links`,
      payload: {
        platform_name: "Website",
        url: "https://example.invalid/first",
      },
    });
    expect(social.statusCode, social.body).toBe(201);
    const socialId = social.json().data.id as number;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/creators/${creatorId}/social-links`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/creators/${creatorId}/social-links/${socialId}`,
          payload: { url: "https://example.invalid/updated" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/creators/${creatorId}/social-links/${socialId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/creators/${creatorId}/social-links/bulk`,
          payload: {
            items: [
              {
                platform_name: "Portfolio",
                url: "https://example.invalid/portfolio",
              },
            ],
          },
        })
      ).statusCode
    ).toBe(200);

    const alias = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/aliases`,
      payload: { name: "HTTP Alias" },
    });
    expect(alias.statusCode, alias.body).toBe(201);
    const aliasId = alias.json().data.id as number;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/creators/${creatorId}/aliases`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/creators/${creatorId}/aliases/${aliasId}`,
          payload: { note: "updated" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/creators/${creatorId}/aliases/${aliasId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/creators/${creatorId}/aliases/bulk`,
          payload: { items: [{ name: "Bulk HTTP Alias" }] },
        })
      ).statusCode
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/creators/${creatorId}/studios/${studioId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/creators/${creatorId}/studios`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/creators/${creatorId}/videos`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/creators/${creatorId}/studios/${studioId}`,
        })
      ).statusCode
    ).toBe(200);
  });

  it("serves studio social, creator, and video relationships", async () => {
    const creator = await app.inject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Studio Link Creator" },
    });
    const studio = await app.inject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Studio Link Target" },
    });
    const creatorId = creator.json().data.id as number;
    const studioId = studio.json().data.id as number;

    const social = await app.inject({
      method: "POST",
      url: `/api/studios/${studioId}/social-links`,
      payload: {
        platform_name: "Website",
        url: "https://example.invalid/studio-link",
      },
    });
    expect(social.statusCode, social.body).toBe(201);
    const socialId = social.json().data.id as number;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/studios/${studioId}/social-links`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/studios/${studioId}/social-links/${socialId}`,
          payload: { url: "https://example.invalid/studio-updated" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/studios/${studioId}/social-links/${socialId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/studios/${studioId}/social-links/bulk`,
          payload: {
            items: [
              {
                platform_name: "Portfolio",
                url: "https://example.invalid/studio-portfolio",
              },
            ],
          },
        })
      ).statusCode
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/studios/${studioId}/creators/bulk`,
          payload: { creatorIds: [creatorId], action: "add" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/studios/${studioId}/creators`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/studios/${studioId}/creators/${creatorId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/studios/${studioId}/creators/${creatorId}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/studios/${studioId}/creators/${creatorId}`,
        })
      ).statusCode
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/studios/${studioId}/videos/127`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/studios/${studioId}/videos`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/studios/${studioId}/videos/127`,
        })
      ).statusCode
    ).toBe(200);
  });
});
