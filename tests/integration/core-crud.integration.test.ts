import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { TestApp } from "../helpers/test-app";
import {
  createTestApp,
  seedVideoFixture,
  TEST_THUMBNAIL_PATH,
} from "../helpers/test-app";

describe("Fastify app integration", () => {
  let ctx: TestApp | undefined;
  let tempDir: string | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
    tempDir = await mkdtemp(join(tmpdir(), "conversor-video-api-"));
  }, 60_000);

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    await ctx?.close();
  });

  it("serves health without authentication", async () => {
    const response = await ctx!.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
    });
  });

  it("rejects protected API routes without a session", async () => {
    const response = await ctx!.inject({
      method: "GET",
      url: "/api/directories",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        statusCode: 401,
      },
    });
  });

  it("returns the authenticated user from /api/auth/me", async () => {
    const response = await ctx!.authInject({
      method: "GET",
      url: "/api/auth/me",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        id: ctx!.userId,
        email: expect.stringContaining("@example.test"),
      },
    });
  });

  it("returns the global not-found payload for unknown routes", async () => {
    const response = await ctx!.inject({
      method: "GET",
      url: "/api/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        message: "Route not found",
        statusCode: 404,
      },
    });
  });

  it("preserves edit history and atomically blocks source deletion while a job is active", async () => {
    const activeSource = await seedVideoFixture("active-edit-source.mp4");
    const otherSource = await seedVideoFixture("bulk-delete-peer.mp4");
    const { db } = await import("@/config/drizzle");
    const { editJobsTable, videosTable } = await import("@/database/schema");
    const { eq, inArray } = await import("drizzle-orm");

    const [job] = await db
      .insert(editJobsTable)
      .values({
        videoId: activeSource.videoId,
        activeVideoId: activeSource.videoId,
        status: "queued",
        progress: 0,
        outputConfig: {
          directory_id: activeSource.directoryId,
          file_name: "history-preserved.mkv",
        },
        timelineConfig: { segments: [{ start: 0, end: 10 }] },
      })
      .returning({ id: editJobsTable.id });

    const blocked = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/bulk/delete",
      payload: { ids: [activeSource.videoId, otherSource.videoId] },
    });
    expect(blocked.statusCode).toBe(409);

    const videosAfterBlockedDelete = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(
        inArray(videosTable.id, [activeSource.videoId, otherSource.videoId])
      );
    expect(videosAfterBlockedDelete).toHaveLength(2);

    await db
      .update(editJobsTable)
      .set({
        status: "cancelled",
        activeVideoId: null,
        completedAt: new Date(),
      })
      .where(eq(editJobsTable.id, job!.id));

    const removed = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/bulk/delete",
      payload: { ids: [activeSource.videoId, otherSource.videoId] },
    });
    expect(removed.statusCode).toBe(200);

    const [historicalJob] = await db
      .select({
        videoId: editJobsTable.videoId,
        activeVideoId: editJobsTable.activeVideoId,
        status: editJobsTable.status,
      })
      .from(editJobsTable)
      .where(eq(editJobsTable.id, job!.id));
    expect(historicalJob).toEqual({
      videoId: activeSource.videoId,
      activeVideoId: null,
      status: "cancelled",
    });
  });

  it("creates, lists, reads, updates, scans, stats, and deletes directories", async () => {
    const create = await ctx!.authInject({
      method: "POST",
      url: "/api/directories",
      payload: {
        path: tempDir!,
        auto_scan: false,
        scan_interval_minutes: 15,
      },
    });

    expect(create.statusCode).toBe(201);
    const directory = create.json().data as { id: number; path: string };
    expect(directory.path).toBe(tempDir!);

    const list = await ctx!.authInject({
      method: "GET",
      url: "/api/directories",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: directory.id })]),
    );

    const read = await ctx!.authInject({
      method: "GET",
      url: `/api/directories/${directory.id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.id).toBe(directory.id);

    const update = await ctx!.authInject({
      method: "PATCH",
      url: `/api/directories/${directory.id}`,
      payload: {
        auto_scan: true,
        scan_interval_minutes: 30,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.auto_scan).toBe(true);

    const scan = await ctx!.authInject({
      method: "POST",
      url: `/api/directories/${directory.id}/scan`,
    });
    expect(scan.statusCode).toBe(202);
    expect(scan.headers.location).toBe(
      `/api/directories/${directory.id}/scans/${scan.json().data.id}`,
    );

    const history = await ctx!.authInject({
      method: "GET",
      url: `/api/directories/${directory.id}/scans?page=1&limit=20`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: scan.json().data.id,
          directory_id: directory.id,
          status: "completed",
        }),
      ]),
    );

    const scheduler = await ctx!.authInject({
      method: "GET",
      url: "/api/directories/scheduler/status",
    });
    expect(scheduler.statusCode).toBe(200);
    expect(scheduler.json().data).toMatchObject({
      is_running: false,
      scheduled_directories: 0,
    });

    const stats = await ctx!.authInject({
      method: "GET",
      url: `/api/directories/${directory.id}/stats`,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({
      success: true,
      data: {
        total_videos: 0,
      },
    });

    const remove = await ctx!.authInject({
      method: "DELETE",
      url: `/api/directories/${directory.id}`,
    });
    expect(remove.statusCode).toBe(200);

    const missing = await ctx!.authInject({
      method: "GET",
      url: `/api/directories/${directory.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates, lists, reads, updates children, videos, and deletes tags", async () => {
    const parentResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: {
        name: "Integration Parent",
        description: "Parent tag",
        color: "#ff0000",
      },
    });
    expect(parentResponse.statusCode).toBe(201);
    const parent = parentResponse.json().data as { id: number };

    const childResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: {
        name: "Integration Child",
        parent_id: parent.id,
      },
    });
    expect(childResponse.statusCode).toBe(201);
    const child = childResponse.json().data as { id: number };

    const list = await ctx!.authInject({
      method: "GET",
      url: "/api/tags?limit=50",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: parent.id })]),
    );

    const read = await ctx!.authInject({
      method: "GET",
      url: `/api/tags/${parent.id}`,
    });
    expect(read.statusCode).toBe(200);

    const children = await ctx!.authInject({
      method: "GET",
      url: `/api/tags/${parent.id}/children`,
    });
    expect(children.statusCode).toBe(200);
    expect(children.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: child.id })]),
    );

    const videos = await ctx!.authInject({
      method: "GET",
      url: `/api/tags/${parent.id}/videos`,
    });
    expect(videos.statusCode).toBe(200);
    expect(videos.json().data).toEqual([]);

    const update = await ctx!.authInject({
      method: "PATCH",
      url: `/api/tags/${child.id}`,
      payload: {
        description: "Updated child",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.description).toBe("Updated child");

    const remove = await ctx!.authInject({
      method: "DELETE",
      url: `/api/tags/${parent.id}`,
    });
    expect(remove.statusCode).toBe(200);
  });

  it("covers creator and studio CRUD endpoints", async () => {
    const creatorCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: {
        name: "Integration Creator",
        description: "Created by integration tests",
      },
    });
    expect(creatorCreate.statusCode).toBe(201);
    const creator = creatorCreate.json().data as { id: number };

    const creatorList = await ctx!.authInject({
      method: "GET",
      url: "/api/creators?search=Integration",
    });
    expect(creatorList.statusCode).toBe(200);
    expect(creatorList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: creator.id })]),
    );

    const creatorRead = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}`,
    });
    expect(creatorRead.statusCode).toBe(200);

    const creatorUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/creators/${creator.id}`,
      payload: {
        description: "Updated creator",
      },
    });
    expect(creatorUpdate.statusCode).toBe(200);
    expect(creatorUpdate.json().data.description).toBe("Updated creator");

    const studioCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: {
        name: "Integration Studio",
        description: "Created by integration tests",
      },
    });
    expect(studioCreate.statusCode).toBe(201);
    const studio = studioCreate.json().data as { id: number };

    const studioList = await ctx!.authInject({
      method: "GET",
      url: "/api/studios?search=Integration",
    });
    expect(studioList.statusCode).toBe(200);
    expect(studioList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: studio.id })]),
    );

    const studioRead = await ctx!.authInject({
      method: "GET",
      url: `/api/studios/${studio.id}`,
    });
    expect(studioRead.statusCode).toBe(200);

    const studioUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/studios/${studio.id}`,
      payload: {
        description: "Updated studio",
      },
    });
    expect(studioUpdate.statusCode).toBe(200);
    expect(studioUpdate.json().data.description).toBe("Updated studio");

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/studios/${studio.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers creator platform, social, gallery, favorite, bulk, recent, quick-create, and studio relationship endpoints", async () => {
    const fixture = await seedVideoFixture("creator-subresources.mp4");
    const { db } = await import("@/config/drizzle");
    const { creatorGalleryMediaTable, platformsTable } = await import(
      "@/database/schema"
    );

    const [platform] = await db
      .insert(platformsTable)
      .values({
        name: `Integration Platform ${Date.now()}`,
        baseUrl: "https://platform.example.test",
      })
      .returning({ id: platformsTable.id });

    const creatorCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: {
        name: `Creator Subresources ${Date.now()}`,
        description: "Subresource coverage",
      },
    });
    expect(creatorCreate.statusCode).toBe(201);
    const creator = creatorCreate.json().data as { id: number };

    const studioCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: {
        name: `Creator Linked Studio ${Date.now()}`,
      },
    });
    expect(studioCreate.statusCode).toBe(201);
    const studio = studioCreate.json().data as { id: number };

    const favoriteBefore = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/favorite/check`,
    });
    expect(favoriteBefore.statusCode).toBe(200);
    expect(favoriteBefore.json().data.is_favorite).toBe(false);

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/creators/${creator.id}/favorite`,
        })
      ).statusCode,
    ).toBe(201);

    const platformCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/platforms`,
      payload: {
        platform_id: platform.id,
        username: "creator-user",
        profile_url: "https://platform.example.test/creator-user",
        is_primary: true,
      },
    });
    expect(platformCreate.statusCode).toBe(201);
    const profile = platformCreate.json().data as { id: number };

    const platformList = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/platforms`,
    });
    expect(platformList.statusCode).toBe(200);
    expect(platformList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: profile.id })]),
    );

    const platformUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/creators/${creator.id}/platforms/${profile.id}`,
      payload: {
        username: "creator-user-updated",
      },
    });
    expect(platformUpdate.statusCode).toBe(200);
    expect(platformUpdate.json().data.username).toBe("creator-user-updated");

    const socialCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/social-links`,
      payload: {
        platform_name: "Website",
        url: "https://creator.example.test",
      },
    });
    expect(socialCreate.statusCode).toBe(201);
    const social = socialCreate.json().data as { id: number };

    const socialBulk = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/social-links/bulk`,
      payload: {
        items: [
          {
            platform_name: "Twitter",
            url: "https://twitter.example.test/creator",
          },
        ],
      },
    });
    expect(socialBulk.statusCode).toBe(200);
    expect(socialBulk.json().data.created.length).toBe(1);

    const socialList = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/social-links`,
    });
    expect(socialList.statusCode).toBe(200);
    expect(socialList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: social.id })]),
    );

    const socialUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/creators/${creator.id}/social-links/${social.id}`,
      payload: {
        platform_name: "Homepage",
      },
    });
    expect(socialUpdate.statusCode).toBe(200);
    expect(socialUpdate.json().data.platform_name).toBe("Homepage");

    const galleryEmpty = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/gallery`,
    });
    expect(galleryEmpty.statusCode).toBe(200);

    const galleryNoFile = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/gallery`,
      payload: Buffer.from("--empty-boundary--\r\n"),
      headers: {
        "content-type": "multipart/form-data; boundary=empty-boundary",
      },
    });
    expect(galleryNoFile.statusCode).toBe(400);

    const galleryPath = join(tempDir!, `creator-gallery-${creator.id}.jpg`);
    await writeFile(galleryPath, Buffer.from("jpg"));

    const [galleryMedia] = await db
      .insert(creatorGalleryMediaTable)
      .values({
        creatorId: creator.id,
        label: "Fixture gallery",
        description: "Seeded media",
        filePath: galleryPath,
      })
      .returning({ id: creatorGalleryMediaTable.id });

    const galleryImage = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/gallery/${galleryMedia.id}/image`,
    });
    expect(galleryImage.statusCode).toBe(200);
    expect(galleryImage.headers["content-type"]).toContain("image/jpeg");

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/creators/${creator.id}/studios/${studio.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const creatorStudios = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/studios`,
    });
    expect(creatorStudios.statusCode).toBe(200);
    expect(creatorStudios.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: studio.id })]),
    );

    const creatorVideos = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/videos?limit=10`,
    });
    expect(creatorVideos.statusCode).toBe(200);

    const platformBulk = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/platforms/bulk`,
      payload: {
        items: [
          {
            platform_id: platform.id,
            username: "creator-user-updated",
            profile_url: "https://platform.example.test/creator-user-bulk",
            is_primary: false,
          },
        ],
      },
    });
    expect(platformBulk.statusCode).toBe(200);
    expect(platformBulk.json().data.updated.length).toBe(1);

    const bulkPreview = await ctx!.authInject({
      method: "POST",
      url: "/api/creators/bulk?dry_run=true",
      payload: {
        mode: "merge",
        items: [
          {
            name: `Bulk Creator ${Date.now()}`,
            description: "Preview import",
            link_video_ids: [fixture.videoId],
          },
        ],
      },
    });
    expect(bulkPreview.statusCode).toBe(200);
    expect(bulkPreview.json().data.dry_run).toBe(true);

    const autocomplete = await ctx!.authInject({
      method: "GET",
      url: "/api/creators/autocomplete?q=Creator&limit=5",
    });
    expect(autocomplete.statusCode).toBe(200);

    const recent = await ctx!.authInject({
      method: "GET",
      url: "/api/creators/recent?limit=5",
    });
    expect(recent.statusCode).toBe(200);

    const quickCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators/quick-create",
      payload: {
        name: `Quick Creator ${Date.now()}`,
      },
    });
    expect(quickCreate.statusCode).toBe(201);

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/gallery/${galleryMedia.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/social-links/${social.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/platforms/${profile.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/favorite`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/studios/${studio.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers creator alias create, list, update, bulk, conflict, and delete endpoints", async () => {
    const creatorCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: {
        name: `Creator Aliases ${Date.now()}`,
        description: "Alias coverage",
      },
    });
    expect(creatorCreate.statusCode).toBe(201);
    const creator = creatorCreate.json().data as { id: number };

    // Add an alias
    const aliasCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/aliases`,
      payload: {
        name: "Stage Name",
        note: "Used on stage",
      },
    });
    expect(aliasCreate.statusCode).toBe(201);
    const alias = aliasCreate.json().data as {
      id: number;
      name: string;
      note: string | null;
    };
    expect(alias.name).toBe("Stage Name");
    expect(alias.note).toBe("Used on stage");

    // Duplicate alias should conflict
    const aliasDuplicate = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/aliases`,
      payload: { name: "Stage Name" },
    });
    expect(aliasDuplicate.statusCode).toBe(409);

    // List aliases
    const aliasList = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/aliases`,
    });
    expect(aliasList.statusCode).toBe(200);
    expect(aliasList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: alias.id })]),
    );

    // Update alias
    const aliasUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/creators/${creator.id}/aliases/${alias.id}`,
      payload: { name: "Maiden Name", note: null },
    });
    expect(aliasUpdate.statusCode).toBe(200);
    expect(aliasUpdate.json().data.name).toBe("Maiden Name");
    expect(aliasUpdate.json().data.note).toBeNull();

    // Bulk upsert aliases (one update of existing by name, one create)
    const aliasBulk = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/aliases/bulk`,
      payload: {
        items: [
          { name: "Maiden Name", note: "Updated via bulk" },
          { name: "Nickname" },
        ],
      },
    });
    expect(aliasBulk.statusCode).toBe(200);
    expect(aliasBulk.json().data.created.length).toBe(1);
    expect(aliasBulk.json().data.updated.length).toBe(1);

    // Adding an alias to a missing creator yields 404
    const aliasMissingCreator = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/99999999/aliases`,
      payload: { name: "Ghost" },
    });
    expect(aliasMissingCreator.statusCode).toBe(404);

    // Delete alias
    const aliasDelete = await ctx!.authInject({
      method: "DELETE",
      url: `/api/creators/${creator.id}/aliases/${alias.id}`,
    });
    expect(aliasDelete.statusCode).toBe(200);

    // Deleting a missing alias yields 404
    const aliasDeleteMissing = await ctx!.authInject({
      method: "DELETE",
      url: `/api/creators/${creator.id}/aliases/99999999`,
    });
    expect(aliasDeleteMissing.statusCode).toBe(404);
  });

  it("covers studio social, relationship, video, bulk, recent, and quick-create endpoints", async () => {
    const fixture = await seedVideoFixture("studio-subresources.mp4");

    const creatorCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: {
        name: `Studio Linked Creator ${Date.now()}`,
      },
    });
    expect(creatorCreate.statusCode).toBe(201);
    const creator = creatorCreate.json().data as { id: number };

    const studioCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: {
        name: `Studio Subresources ${Date.now()}`,
        description: "Subresource coverage",
      },
    });
    expect(studioCreate.statusCode).toBe(201);
    const studio = studioCreate.json().data as { id: number };

    const socialCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/studios/${studio.id}/social-links`,
      payload: {
        platform_name: "Website",
        url: "https://studio.example.test",
      },
    });
    expect(socialCreate.statusCode).toBe(201);
    const social = socialCreate.json().data as { id: number };

    const socialBulk = await ctx!.authInject({
      method: "POST",
      url: `/api/studios/${studio.id}/social-links/bulk`,
      payload: {
        items: [
          {
            platform_name: "Twitter",
            url: "https://twitter.example.test/studio",
          },
        ],
      },
    });
    expect(socialBulk.statusCode).toBe(200);
    expect(socialBulk.json().data.created.length).toBe(1);

    const socialList = await ctx!.authInject({
      method: "GET",
      url: `/api/studios/${studio.id}/social-links`,
    });
    expect(socialList.statusCode).toBe(200);
    expect(socialList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: social.id })]),
    );

    const socialUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/studios/${studio.id}/social-links/${social.id}`,
      payload: {
        platform_name: "Homepage",
      },
    });
    expect(socialUpdate.statusCode).toBe(200);
    expect(socialUpdate.json().data.platform_name).toBe("Homepage");

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/studios/${studio.id}/creators/${creator.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/studios/${studio.id}/videos/${fixture.videoId}`,
        })
      ).statusCode,
    ).toBe(200);

    const creators = await ctx!.authInject({
      method: "GET",
      url: `/api/studios/${studio.id}/creators`,
    });
    expect(creators.statusCode).toBe(200);
    expect(creators.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: creator.id })]),
    );

    const videos = await ctx!.authInject({
      method: "GET",
      url: `/api/studios/${studio.id}/videos?limit=10`,
    });
    expect(videos.statusCode).toBe(200);
    expect(videos.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.videoId })]),
    );

    const bulkCreators = await ctx!.authInject({
      method: "POST",
      url: `/api/studios/${studio.id}/creators/bulk`,
      payload: {
        creatorIds: [creator.id],
        action: "remove",
      },
    });
    expect(bulkCreators.statusCode).toBe(200);

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/studios/${studio.id}/creators/${creator.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const bulkPreview = await ctx!.authInject({
      method: "POST",
      url: "/api/studios/bulk?dry_run=true",
      payload: {
        mode: "merge",
        items: [
          {
            name: `Bulk Studio ${Date.now()}`,
            link_creator_ids: [creator.id],
            link_video_ids: [fixture.videoId],
          },
        ],
      },
    });
    expect(bulkPreview.statusCode).toBe(200);
    expect(bulkPreview.json().data.dry_run).toBe(true);

    const autocomplete = await ctx!.authInject({
      method: "GET",
      url: "/api/studios/autocomplete?q=Studio&limit=5",
    });
    expect(autocomplete.statusCode).toBe(200);

    const recent = await ctx!.authInject({
      method: "GET",
      url: "/api/studios/recent?limit=5",
    });
    expect(recent.statusCode).toBe(200);

    const quickCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/studios/quick-create",
      payload: {
        name: `Quick Studio ${Date.now()}`,
      },
    });
    expect(quickCreate.statusCode).toBe(201);

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/studios/${studio.id}/social-links/${social.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/studios/${studio.id}/videos/${fixture.videoId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/studios/${studio.id}/creators/${creator.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers face recognition endpoints with mocked detector services", async () => {
    const fixture = await seedVideoFixture("face-recognition.mp4");
    const { db } = await import("@/config/drizzle");
    const { creatorFaceEmbeddingsTable } = await import("@/database/schema");

    const creatorCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: {
        name: `Face Match Creator ${Date.now()}`,
      },
    });
    expect(creatorCreate.statusCode).toBe(201);
    const creator = creatorCreate.json().data as { id: number };

    const health = await ctx!.authInject({
      method: "GET",
      url: "/api/faces/health",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe("ok");

    const uploadBase64 = await ctx!.authInject({
      method: "POST",
      url: `/api/creators/${creator.id}/face-embeddings/base64`,
      payload: {
        image_base64: Buffer.from("jpg").toString("base64"),
        is_primary: true,
      },
    });
    expect(uploadBase64.statusCode).toBe(200);
    expect(uploadBase64.json().data.creatorId).toBe(creator.id);

    const embeddings = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/face-embeddings`,
    });
    expect(embeddings.statusCode).toBe(200);
    expect(embeddings.json().data[0].image_url).toContain(
      `/api/creators/${creator.id}/face-embeddings/1/thumbnail`,
    );

    const [storedEmbedding] = await db
      .insert(creatorFaceEmbeddingsTable)
      .values({
        creatorId: creator.id,
        embedding: JSON.stringify(Array.from({ length: 512 }, () => 0.1)),
        sourceType: "manual_upload",
        isPrimary: true,
        detScore: 0.99,
        thumbnailPath: TEST_THUMBNAIL_PATH,
      })
      .returning({ id: creatorFaceEmbeddingsTable.id });

    const thumbnail = await ctx!.inject({
      method: "GET",
      url: `/api/creators/${creator.id}/face-embeddings/${storedEmbedding.id}/thumbnail`,
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/webp");

    expect(
      (
        await ctx!.authInject({
          method: "PUT",
          url: `/api/creators/${creator.id}/face-embeddings/${storedEmbedding.id}/primary`,
        })
      ).statusCode,
    ).toBe(200);

    const faces = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/faces`,
    });
    expect(faces.statusCode).toBe(200);
    expect(faces.json().data[0]).toMatchObject({
      videoId: fixture.videoId,
      matchStatus: "confirmed",
    });

    const faceImage = await ctx!.inject({
      method: "GET",
      url: "/api/faces/1/image",
    });
    expect(faceImage.statusCode).toBe(200);
    expect(faceImage.headers["content-type"]).toContain("image/jpeg");

    const extract = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/faces/extract`,
    });
    expect(extract.statusCode).toBe(202);

    expect(
      (
        await ctx!.authInject({
          method: "PUT",
          url: `/api/videos/${fixture.videoId}/faces/1/confirm`,
          payload: {
            creator_id: creator.id,
          },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await ctx!.authInject({
          method: "PUT",
          url: `/api/videos/${fixture.videoId}/faces/1/reject`,
        })
      ).statusCode,
    ).toBe(200);

    const videosByFace = await ctx!.authInject({
      method: "GET",
      url: `/api/creators/${creator.id}/videos-by-face?min_confidence=0.5`,
    });
    expect(videosByFace.statusCode).toBe(200);
    expect(videosByFace.json().data[0].creator_id).toBe(creator.id);

    const missingSearchFile = await ctx!.authInject({
      method: "POST",
      url: "/api/faces/search?limit=3&threshold=0.5",
      payload: Buffer.from("--empty-boundary--\r\n"),
      headers: {
        "content-type": "multipart/form-data; boundary=empty-boundary",
      },
    });
    expect(missingSearchFile.statusCode).toBe(400);

    const status = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/faces/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.videoId).toBe(fixture.videoId);

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: "/api/faces/queue",
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/creators/${creator.id}/face-embeddings/${storedEmbedding.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers favorites and playlist endpoints using a seeded video", async () => {
    const fixture = await seedVideoFixture();

    const favoriteCheckBefore = await ctx!.authInject({
      method: "GET",
      url: `/api/favorites/${fixture.videoId}/check`,
    });
    expect(favoriteCheckBefore.statusCode).toBe(200);
    expect(favoriteCheckBefore.json().data.is_favorite).toBe(false);

    const favoriteAdd = await ctx!.authInject({
      method: "POST",
      url: "/api/favorites",
      payload: {
        video_id: fixture.videoId,
      },
    });
    expect(favoriteAdd.statusCode).toBe(201);

    const favoriteList = await ctx!.authInject({
      method: "GET",
      url: "/api/favorites",
    });
    expect(favoriteList.statusCode).toBe(200);
    expect(favoriteList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.videoId })]),
    );

    const favoriteRemove = await ctx!.authInject({
      method: "DELETE",
      url: `/api/favorites/${fixture.videoId}`,
    });
    expect(favoriteRemove.statusCode).toBe(200);

    const playlistCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/playlists",
      payload: {
        name: "Integration Playlist",
        description: "Video grouping",
      },
    });
    expect(playlistCreate.statusCode).toBe(201);
    const playlist = playlistCreate.json().data as { id: number };
    const secondPlaylistVideo = await seedVideoFixture(
      "playlist-cover-member.mp4",
    );
    const playlistOutsider = await seedVideoFixture("playlist-cover-outsider.mp4");

    const playlistList = await ctx!.authInject({
      method: "GET",
      url: "/api/playlists",
    });
    expect(playlistList.statusCode).toBe(200);
    expect(playlistList.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: playlist.id })]),
    );

    const playlistAddVideo = await ctx!.authInject({
      method: "POST",
      url: `/api/playlists/${playlist.id}/videos`,
      payload: {
        video_id: fixture.videoId,
      },
    });
    expect(playlistAddVideo.statusCode).toBe(201);

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/playlists/${playlist.id}/videos`,
          payload: { video_id: secondPlaylistVideo.videoId },
        })
      ).statusCode,
    ).toBe(201);

    const playlistVideos = await ctx!.authInject({
      method: "GET",
      url: `/api/playlists/${playlist.id}/videos`,
    });
    expect(playlistVideos.statusCode).toBe(200);
    expect(playlistVideos.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.videoId, position: 0 }),
      ]),
    );

    const playlistUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/playlists/${playlist.id}`,
      payload: {
        name: "Updated Integration Playlist",
      },
    });
    expect(playlistUpdate.statusCode).toBe(200);
    expect(playlistUpdate.json().data.name).toBe(
      "Updated Integration Playlist",
    );

    const playlistCoverUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/playlists/${playlist.id}`,
      payload: { artwork_source_video_id: secondPlaylistVideo.videoId },
    });
    expect(playlistCoverUpdate.statusCode).toBe(200);
    expect(playlistCoverUpdate.json().data.artwork_source_video_id).toBe(
      secondPlaylistVideo.videoId,
    );

    const playlistCoverRejected = await ctx!.authInject({
      method: "PATCH",
      url: `/api/playlists/${playlist.id}`,
      payload: { artwork_source_video_id: playlistOutsider.videoId },
    });
    expect(playlistCoverRejected.statusCode).toBe(400);
    expect(playlistCoverRejected.json().error.message).toBe(
      "Artwork source video must belong to this playlist",
    );

    expect(
      (
        await ctx!.authInject({
          method: "PATCH",
          url: `/api/playlists/${playlist.id}/videos/reorder`,
          payload: {
            videos: [
              { video_id: secondPlaylistVideo.videoId, position: 0 },
              { video_id: fixture.videoId, position: 1 },
            ],
          },
        })
      ).statusCode,
    ).toBe(200);
    const playlistAfterReorder = await ctx!.authInject({
      method: "GET",
      url: `/api/playlists/${playlist.id}`,
    });
    expect(playlistAfterReorder.json().data.artwork_source_video_id).toBe(
      secondPlaylistVideo.videoId,
    );

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/playlists/${playlist.id}/videos/bulk`,
          payload: {
            videoIds: [secondPlaylistVideo.videoId],
            action: "remove",
          },
        })
      ).statusCode,
    ).toBe(200);
    const playlistAfterSourceRemoval = await ctx!.authInject({
      method: "GET",
      url: `/api/playlists/${playlist.id}`,
    });
    expect(playlistAfterSourceRemoval.json().data.artwork_source_video_id).toBe(
      fixture.videoId,
    );

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/playlists/${playlist.id}/videos/${fixture.videoId}`,
        })
      ).statusCode,
    ).toBe(200);
    const emptyPlaylist = await ctx!.authInject({
      method: "GET",
      url: `/api/playlists/${playlist.id}`,
    });
    expect(emptyPlaylist.json().data.artwork_source_video_id).toBeNull();
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/playlists/${playlist.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers video collection endpoints using a seeded video", async () => {
    const fixture = await seedVideoFixture("collection-fixture.mp4");
    const secondCollectionVideo = await seedVideoFixture(
      "collection-cover-member.mp4",
    );
    const collectionOutsider = await seedVideoFixture(
      "collection-cover-outsider.mp4",
    );

    const create = await ctx!.authInject({
      method: "POST",
      url: "/api/video-collections",
      payload: {
        title: "Integration Collection",
        kind: "tv_series",
        description: "Collection created by tests",
        release_year: 2026,
      },
    });
    expect(create.statusCode).toBe(201);
    const collection = create.json().data as { id: number };

    const list = await ctx!.authInject({
      method: "GET",
      url: "/api/video-collections",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: collection.id })]),
    );

    const entryCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/video-collections/${collection.id}/entries`,
      payload: {
        video_id: fixture.videoId,
        entry_kind: "episode",
        sequence_number: 1,
        season_number: 1,
        episode_number: 1,
      },
    });
    expect(entryCreate.statusCode).toBe(201);
    expect(entryCreate.json().data[0].video_id).toBe(fixture.videoId);

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/video-collections/${collection.id}/entries`,
          payload: {
            video_id: secondCollectionVideo.videoId,
            entry_kind: "episode",
            sequence_number: 2,
            season_number: 1,
            episode_number: 2,
          },
        })
      ).statusCode,
    ).toBe(201);

    const entries = await ctx!.authInject({
      method: "GET",
      url: `/api/video-collections/${collection.id}/entries`,
    });
    expect(entries.statusCode).toBe(200);
    expect(entries.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ video_id: fixture.videoId }),
      ]),
    );

    const update = await ctx!.authInject({
      method: "PATCH",
      url: `/api/video-collections/${collection.id}`,
      payload: {
        description: "Updated collection",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.description).toBe("Updated collection");

    const collectionCoverUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/video-collections/${collection.id}`,
      payload: { artwork_source_video_id: secondCollectionVideo.videoId },
    });
    expect(collectionCoverUpdate.statusCode).toBe(200);
    expect(collectionCoverUpdate.json().data.artwork_source_video_id).toBe(
      secondCollectionVideo.videoId,
    );

    const collectionCoverRejected = await ctx!.authInject({
      method: "PATCH",
      url: `/api/video-collections/${collection.id}`,
      payload: { artwork_source_video_id: collectionOutsider.videoId },
    });
    expect(collectionCoverRejected.statusCode).toBe(400);
    expect(collectionCoverRejected.json().error.message).toBe(
      "Artwork source video must belong to this collection",
    );

    expect(
      (
        await ctx!.authInject({
          method: "PATCH",
          url: `/api/video-collections/${collection.id}/entries/reorder`,
          payload: {
            entries: [
              { video_id: secondCollectionVideo.videoId, sequence_number: 1 },
              { video_id: fixture.videoId, sequence_number: 2 },
            ],
          },
        })
      ).statusCode,
    ).toBe(200);
    const collectionAfterReorder = await ctx!.authInject({
      method: "GET",
      url: `/api/video-collections/${collection.id}`,
    });
    expect(collectionAfterReorder.json().data.artwork_source_video_id).toBe(
      secondCollectionVideo.videoId,
    );

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/video-collections/${collection.id}/entries/${secondCollectionVideo.videoId}`,
        })
      ).statusCode,
    ).toBe(200);
    const collectionAfterSourceRemoval = await ctx!.authInject({
      method: "GET",
      url: `/api/video-collections/${collection.id}`,
    });
    expect(collectionAfterSourceRemoval.json().data.artwork_source_video_id).toBe(
      fixture.videoId,
    );

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/video-collections/${collection.id}/entries/${fixture.videoId}`,
        })
      ).statusCode,
    ).toBe(200);
    const emptyCollection = await ctx!.authInject({
      method: "GET",
      url: `/api/video-collections/${collection.id}`,
    });
    expect(emptyCollection.json().data.artwork_source_video_id).toBeNull();
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/video-collections/${collection.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("covers video detail, metadata, relationships, ratings, and bookmarks", async () => {
    const fixture = await seedVideoFixture("video-surface.mp4");

    const list = await ctx!.authInject({
      method: "GET",
      url: "/api/videos?limit=20&include=creators,tags,studios",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.videoId })]),
    );
    const listedVideo = list
      .json()
      .data.find((video: { id: number }) => video.id === fixture.videoId) as {
      created_at: string;
    };
    const createdAtMs = new Date(listedVideo.created_at).getTime();
    const dateFilteredList = await ctx!.authInject({
      method: "GET",
      url: `/api/videos?createdFrom=${encodeURIComponent(new Date(createdAtMs - 1).toISOString())}&createdBefore=${encodeURIComponent(new Date(createdAtMs + 1).toISOString())}`,
    });
    expect(dateFilteredList.statusCode).toBe(200);
    expect(dateFilteredList.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.videoId }),
      ]),
    );

    const random = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/random",
    });
    expect(random.statusCode).toBe(200);

    const read = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}?include=creators,tags,studios`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.id).toBe(fixture.videoId);

    const update = await ctx!.authInject({
      method: "PATCH",
      url: `/api/videos/${fixture.videoId}`,
      payload: {
        title: "Updated seeded video",
        description: "Updated through Fastify inject",
        themes: "integration",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.title).toBe("Updated seeded video");

    const creatorResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Video Relationship Creator" },
    });
    expect(creatorResponse.statusCode).toBe(201);
    const creatorId = creatorResponse.json().data.id as number;

    const tagResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Video Relationship Tag", color: "#336699" },
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().data.id as number;

    const studioResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Video Relationship Studio" },
    });
    expect(studioResponse.statusCode).toBe(201);
    const studioId = studioResponse.json().data.id as number;

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/videos/${fixture.videoId}/creators`,
          payload: { creator_id: creatorId },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await ctx!.authInject({
          method: "GET",
          url: `/api/videos/${fixture.videoId}/creators`,
        })
      ).json().data,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: creatorId })]));

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/videos/${fixture.videoId}/tags`,
          payload: { tag_id: tagId },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await ctx!.authInject({
          method: "GET",
          url: `/api/videos/${fixture.videoId}/tags`,
        })
      ).json().data,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: tagId })]));

    expect(
      (
        await ctx!.authInject({
          method: "POST",
          url: `/api/videos/${fixture.videoId}/studios/${studioId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "GET",
          url: `/api/videos/${fixture.videoId}/studios`,
        })
      ).json().data,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: studioId })]));

    const enrichedVideo = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}?include=creators,tags,studios,stats`,
    });
    expect(enrichedVideo.statusCode).toBe(200);
    expect(enrichedVideo.json().data).toMatchObject({
      play_count: 0,
      last_played_at: null,
      creators: [
        expect.objectContaining({
          id: creatorId,
          profile_picture_url: null,
        }),
      ],
      tags: [
        expect.objectContaining({
          id: tagId,
          color: "#336699",
          parent_id: null,
        }),
      ],
      studios: [
        expect.objectContaining({
          id: studioId,
          profile_picture_url: null,
        }),
      ],
    });

    const tagsByVideoCount = await ctx!.authInject({
      method: "GET",
      url: "/api/tags?sort=video_count&order=desc&limit=100",
    });
    expect(tagsByVideoCount.statusCode).toBe(200);
    expect(tagsByVideoCount.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: tagId, video_count: 1 }),
      ]),
    );

    const crossEntitySearch = await ctx!.authInject({
      method: "GET",
      url: "/api/search?q=Relationship&limit=3",
    });
    expect(crossEntitySearch.statusCode).toBe(200);
    expect(crossEntitySearch.json()).toMatchObject({
      creators: [expect.objectContaining({ id: creatorId })],
      studios: [expect.objectContaining({ id: studioId })],
      tags: [expect.objectContaining({ id: tagId })],
      totals: {
        videos: 0,
        creators: 1,
        studios: 1,
        tags: 1,
        collections: 0,
        playlists: 0,
      },
    });

    const metadataCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/metadata`,
      payload: {
        key: "source",
        value: "integration",
      },
    });
    expect(metadataCreate.statusCode).toBe(201);

    const metadataList = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/metadata`,
    });
    expect(metadataList.statusCode).toBe(200);
    expect(metadataList.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "source", value: "integration" }),
      ]),
    );

    const ratingCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/ratings`,
      payload: {
        rating: 5,
        comment: "Good fixture",
      },
    });
    expect(ratingCreate.statusCode).toBe(201);

    const ratings = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/ratings`,
    });
    expect(ratings.statusCode).toBe(200);
    expect(ratings.json().average).toBe(5);

    const bookmarkCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/bookmarks`,
      payload: {
        timestamp_seconds: 12,
        name: "Interesting frame",
        description: "Created in integration tests",
      },
    });
    expect(bookmarkCreate.statusCode).toBe(201);

    const bookmarks = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/bookmarks`,
    });
    expect(bookmarks.statusCode).toBe(200);
    expect(bookmarks.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Interesting frame" }),
      ]),
    );

    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/videos/${fixture.videoId}/metadata/source`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/videos/${fixture.videoId}/creators/${creatorId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/videos/${fixture.videoId}/tags/${tagId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx!.authInject({
          method: "DELETE",
          url: `/api/videos/${fixture.videoId}/studios/${studioId}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps explicit studio state and related caches coherent in both directions", async () => {
    const primary = await seedVideoFixture("studio-state-primary.mp4");
    const secondary = await seedVideoFixture("studio-state-secondary.mp4");
    const studioResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Studio State Integration" },
    });
    expect(studioResponse.statusCode).toBe(201);
    const studioId = studioResponse.json().data.id as number;

    const { db } = await import("@/config/drizzle");
    const { videoRelatedScoresTable } = await import("@/database/schema");
    const { eq, or } = await import("drizzle-orm");
    const warmBothDirections = async () => {
      await db.delete(videoRelatedScoresTable).where(or(
        eq(videoRelatedScoresTable.sourceVideoId, primary.videoId),
        eq(videoRelatedScoresTable.relatedVideoId, primary.videoId),
      ));
      await db.insert(videoRelatedScoresTable).values([
        {
          sourceVideoId: primary.videoId,
          relatedVideoId: secondary.videoId,
          score: 1,
          reasonsJson: "[]",
        },
        {
          sourceVideoId: secondary.videoId,
          relatedVideoId: primary.videoId,
          score: 1,
          reasonsJson: "[]",
        },
      ]);
    };
    const cachedBothDirections = () => db
      .select()
      .from(videoRelatedScoresTable)
      .where(or(
        eq(videoRelatedScoresTable.sourceVideoId, primary.videoId),
        eq(videoRelatedScoresTable.relatedVideoId, primary.videoId),
      ));

    await warmBothDirections();
    const confirmedNone = await ctx!.authInject({
      method: "PATCH",
      url: `/api/videos/${primary.videoId}/studio-assignment`,
      payload: { status: "confirmed_none" },
    });
    expect(confirmedNone.statusCode, confirmedNone.body).toBe(200);
    expect(confirmedNone.json().data.studio_assignment_status).toBe("confirmed_none");
    expect(await cachedBothDirections()).toHaveLength(0);

    const linkSecondary = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${secondary.videoId}/studios/${studioId}`,
    });
    expect(linkSecondary.statusCode, linkSecondary.body).toBe(200);

    await warmBothDirections();
    const linked = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${primary.videoId}/studios/${studioId}`,
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(await cachedBothDirections()).toHaveLength(0);
    const assigned = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${primary.videoId}`,
    });
    expect(assigned.json().data.studio_assignment_status).toBe("assigned");

    const recomputed = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${primary.videoId}/related?limit=20&refresh=true`,
    });
    expect(recomputed.statusCode, recomputed.body).toBe(200);
    const recomputedCache = await db.select()
      .from(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, primary.videoId));
    expect(recomputedCache).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relatedVideoId: secondary.videoId,
          reasonsJson: expect.stringContaining("shared-studios"),
        }),
      ])
    );

    await warmBothDirections();
    const conflict = await ctx!.authInject({
      method: "PATCH",
      url: `/api/videos/${primary.videoId}/studio-assignment`,
      payload: { status: "confirmed_none" },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(await cachedBothDirections()).toHaveLength(2);

    const unlinked = await ctx!.authInject({
      method: "DELETE",
      url: `/api/videos/${primary.videoId}/studios/${studioId}`,
    });
    expect(unlinked.statusCode, unlinked.body).toBe(200);
    expect(await cachedBothDirections()).toHaveLength(0);
    const unknown = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${primary.videoId}`,
    });
    expect(unknown.json().data.studio_assignment_status).toBe("unknown");

    await ctx!.authInject({
      method: "PATCH",
      url: `/api/videos/${primary.videoId}/studio-assignment`,
      payload: { status: "confirmed_none" },
    });
    const filtered = await ctx!.authInject({
      method: "GET",
      url: `/api/videos?studioAssignmentStatus=confirmed_none&ids=${primary.videoId}`,
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().data).toEqual([
      expect.objectContaining({
        id: primary.videoId,
        studio_assignment_status: "confirmed_none",
      }),
    ]);
  });

  it("rolls back mixed triage work when confirmed-none includes a linked video", async () => {
    const linked = await seedVideoFixture("studio-mixed-linked.mp4");
    const unlinked = await seedVideoFixture("studio-mixed-unlinked.mp4");
    const studioResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Studio Mixed Rollback" },
    });
    const creatorResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Studio Mixed Creator" },
    });
    const studioId = studioResponse.json().data.id as number;
    const creatorId = creatorResponse.json().data.id as number;
    await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${linked.videoId}/studios/${studioId}`,
    });

    const response = await ctx!.authInject({
      method: "POST",
      url: "/api/triage/bulk-actions",
      payload: {
        videoIds: [linked.videoId, unlinked.videoId],
        actions: {
          addCreatorIds: [creatorId],
          studioAssignmentStatus: "confirmed_none",
        },
      },
    });
    expect(response.statusCode, response.body).toBe(409);

    const { db } = await import("@/config/drizzle");
    const { videoCreatorsTable } = await import("@/database/schema");
    const { and, eq, inArray } = await import("drizzle-orm");
    const creatorLinks = await db.select()
      .from(videoCreatorsTable)
      .where(and(
        inArray(videoCreatorsTable.videoId, [linked.videoId, unlinked.videoId]),
        eq(videoCreatorsTable.creatorId, creatorId),
      ));
    expect(creatorLinks).toHaveLength(0);
    const unlinkedDetail = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${unlinked.videoId}`,
    });
    expect(unlinkedDetail.json().data.studio_assignment_status).toBe("unknown");
  });

  it("serializes a concurrent studio link and confirmed-none decision", async () => {
    const video = await seedVideoFixture("studio-concurrency.mp4");
    const studioResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Studio Concurrency" },
    });
    const studioId = studioResponse.json().data.id as number;

    const [confirmation, linking] = await Promise.all([
      ctx!.authInject({
        method: "PATCH",
        url: `/api/videos/${video.videoId}/studio-assignment`,
        payload: { status: "confirmed_none" },
      }),
      ctx!.authInject({
        method: "POST",
        url: `/api/videos/${video.videoId}/studios/${studioId}`,
      }),
    ]);
    expect(linking.statusCode, linking.body).toBe(200);
    expect([200, 409]).toContain(confirmation.statusCode);

    const detail = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${video.videoId}`,
    });
    expect(detail.json().data.studio_assignment_status).toBe("assigned");
    const { db } = await import("@/config/drizzle");
    const { videosTable } = await import("@/database/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.select({ marker: videosTable.studioAbsenceConfirmedAt })
      .from(videosTable)
      .where(eq(videosTable.id, video.videoId));
    expect(row[0]?.marker).toBeNull();
  });

  it("covers video queues, bulk actions, duplicates, related, and unavailable cleanup", async () => {
    const primary = await seedVideoFixture("video-routes-primary.mp4");
    const secondary = await seedVideoFixture("video-routes-secondary.mp4");
    const unavailable = await seedVideoFixture("video-routes-missing.mp4");

    const creatorResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/creators",
      payload: { name: "Video Bulk Creator" },
    });
    expect(creatorResponse.statusCode).toBe(201);
    const creatorId = creatorResponse.json().data.id as number;

    const tagResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Video Bulk Tag" },
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().data.id as number;

    const studioResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/studios",
      payload: { name: "Video Bulk Studio" },
    });
    expect(studioResponse.statusCode).toBe(201);
    const studioId = studioResponse.json().data.id as number;

    const { db } = await import("@/config/drizzle");
    const { videosTable } = await import("@/database/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(videosTable)
      .set({
        fileHash: "duplicate-hash-for-integration",
        width: 1920,
        height: 1080,
        codec: "h264",
        bitrate: 8_000_000,
      })
      .where(eq(videosTable.id, primary.videoId));
    await db
      .update(videosTable)
      .set({
        fileHash: "duplicate-hash-for-integration",
        width: 1920,
        height: 1080,
        codec: "h264",
        bitrate: 7_500_000,
      })
      .where(eq(videosTable.id, secondary.videoId));

    const queue = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/triage-queue?queueLimit=20",
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().ids).toEqual(
      expect.arrayContaining([primary.videoId, secondary.videoId]),
    );

    const next = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/next?currentId=${primary.videoId}&direction=next`,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().meta).toHaveProperty("total_matching");

    const suggestions = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/compression-suggestions?limit=10",
    });
    expect(suggestions.statusCode).toBe(200);
    expect(suggestions.json()).toHaveProperty("summary");

    const duplicates = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/duplicates",
    });
    expect(duplicates.statusCode).toBe(200);
    expect(duplicates.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_hash: "duplicate-hash-for-integration" }),
      ]),
    );

    const related = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${primary.videoId}/related?limit=5&refresh=true`,
    });
    expect(related.statusCode).toBe(200);
    expect(related.json().meta).toHaveProperty("candidate_count");

    for (const response of [
      await ctx!.authInject({
        method: "POST",
        url: "/api/videos/bulk/creators",
        payload: {
          videoIds: [primary.videoId, secondary.videoId],
          creatorIds: [creatorId],
          action: "add",
        },
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/videos/bulk/tags",
        payload: {
          videoIds: [primary.videoId, secondary.videoId],
          tagIds: [tagId],
          action: "add",
        },
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/videos/bulk/studios",
        payload: {
          videoIds: [primary.videoId, secondary.videoId],
          studioIds: [studioId],
          action: "add",
        },
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/videos/bulk/favorites",
        payload: {
          videoIds: [primary.videoId, secondary.videoId],
          isFavorite: true,
        },
      }),
    ]) {
      expect(response.statusCode).toBe(200);
    }

    const conditional = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/bulk/conditional-apply",
      payload: {
        filter: {
          search: "video-routes-primary",
        },
        actions: {
          addTagIds: [tagId],
        },
      },
    });
    expect(conditional.statusCode).toBe(200);
    expect(conditional.json().data.matched).toBeGreaterThanOrEqual(1);

    const verifyOne = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${unavailable.videoId}/verify`,
    });
    expect(verifyOne.statusCode).toBe(200);
    expect(verifyOne.json().data.is_available).toBe(false);

    const unavailableList = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/unavailable?limit=20",
    });
    expect(unavailableList.statusCode).toBe(200);
    expect(unavailableList.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unavailable.videoId }),
      ]),
    );

    const verifyUnavailable = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/unavailable/verify",
      payload: {},
    });
    expect(verifyUnavailable.statusCode).toBe(200);
    expect(verifyUnavailable.json()).toHaveProperty("checked");

    const cleanup = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/unavailable/cleanup",
      payload: {
        ids: [unavailable.videoId],
      },
    });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json().deleted_ids).toEqual([unavailable.videoId]);
  });

  it("covers settings and per-video watch stats", async () => {
    const fixture = await seedVideoFixture("watch-stats.mp4");

    const settingsBefore = await ctx!.authInject({
      method: "GET",
      url: "/api/settings",
    });
    expect(settingsBefore.statusCode).toBe(200);
    expect(settingsBefore.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "min_watch_seconds" }),
      ]),
    );

    const settingsUpdate = await ctx!.authInject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        settings: {
          min_watch_seconds: 5,
          watch_session_gap_minutes: 30,
        },
      },
    });
    expect(settingsUpdate.statusCode).toBe(200);
    expect(settingsUpdate.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "min_watch_seconds", value: 5 }),
      ]),
    );

    const watch = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/watch`,
      payload: {
        watched_seconds: 6,
        last_position_seconds: 6,
      },
    });
    expect(watch.statusCode).toBe(200);
    expect(watch.json().data).toMatchObject({
      play_count_incremented: true,
      stats: {
        video_id: fixture.videoId,
        play_count: 1,
      },
    });

    const stats = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/stats`,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().data).toMatchObject({
      stats: {
        video_id: fixture.videoId,
        play_count: 1,
      },
      aggregate: {
        video_id: fixture.videoId,
        total_play_count: 1,
      },
    });

    const history = await ctx!.authInject({
      method: "GET",
      url: "/api/videos/history?limit=10&include=artwork,creators,tags,studios",
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          video: expect.objectContaining({
            id: fixture.videoId,
            file_name: "watch-stats.mp4",
            artwork: null,
            creators: [],
            tags: [],
            studios: [],
          }),
          play_count: 1,
          last_position_seconds: 6,
        }),
      ],
      pagination: expect.objectContaining({
        page: 1,
        limit: 10,
      }),
    });

    const playedAt = new Date(watch.json().data.stats.last_played_at).getTime();
    const rediscoveryList = await ctx!.authInject({
      method: "GET",
      url: `/api/videos?minPlayCount=1&lastPlayedAfter=${encodeURIComponent(new Date(playedAt - 1_000).toISOString())}&lastPlayedBefore=${encodeURIComponent(new Date(playedAt + 1_000).toISOString())}&include=stats&limit=100`,
    });
    expect(rediscoveryList.statusCode).toBe(200);
    expect(rediscoveryList.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.videoId,
          play_count: 1,
          last_played_at: expect.any(String),
        }),
      ]),
    );

    const rediscoveryRandom = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/random?minPlayCount=1&lastPlayedAfter=${encodeURIComponent(new Date(playedAt - 1_000).toISOString())}&lastPlayedBefore=${encodeURIComponent(new Date(playedAt + 1_000).toISOString())}`,
    });
    expect(rediscoveryRandom.statusCode).toBe(200);
  });

  it("covers standalone rating and bookmark update/delete endpoints", async () => {
    const fixture = await seedVideoFixture("standalone-rating-bookmark.mp4");

    const ratingCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/ratings`,
      payload: {
        rating: 3,
        comment: "Initial comment",
      },
    });
    expect(ratingCreate.statusCode).toBe(201);
    const ratingId = ratingCreate.json().data.id as number;

    const ratingUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/ratings/${ratingId}`,
      payload: {
        rating: 5,
        comment: "Updated comment",
      },
    });
    expect(ratingUpdate.statusCode).toBe(200);
    expect(ratingUpdate.json().data).toMatchObject({
      id: ratingId,
      rating: 5,
      comment: "Updated comment",
    });

    const ratingDelete = await ctx!.authInject({
      method: "DELETE",
      url: `/api/ratings/${ratingId}`,
    });
    expect(ratingDelete.statusCode).toBe(200);

    const bookmarkCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/bookmarks`,
      payload: {
        timestamp_seconds: 12,
        name: "Initial bookmark",
      },
    });
    expect(bookmarkCreate.statusCode).toBe(201);
    const bookmarkId = bookmarkCreate.json().data.id as number;

    const bookmarkUpdate = await ctx!.authInject({
      method: "PATCH",
      url: `/api/bookmarks/${bookmarkId}`,
      payload: {
        timestamp_seconds: 24,
        name: "Updated bookmark",
      },
    });
    expect(bookmarkUpdate.statusCode).toBe(200);
    expect(bookmarkUpdate.json().data).toMatchObject({
      id: bookmarkId,
      timestamp_seconds: 24,
      name: "Updated bookmark",
    });

    const bookmarkDelete = await ctx!.authInject({
      method: "DELETE",
      url: `/api/bookmarks/${bookmarkId}`,
    });
    expect(bookmarkDelete.statusCode).toBe(200);
  });

  it("covers triage progress, bulk actions, statistics, and legacy aliases", async () => {
    const fixture = await seedVideoFixture("triage.mp4");
    const tagResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Triage Tag" },
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().data.id as number;

    const save = await ctx!.authInject({
      method: "POST",
      url: "/api/triage/progress",
      payload: {
        filterKey: "all",
        lastVideoId: fixture.videoId,
        processedCount: 1,
        totalCount: 3,
      },
    });
    expect(save.statusCode).toBe(200);

    const read = await ctx!.authInject({
      method: "GET",
      url: "/api/triage/progress?filterKey=all",
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({
      filter_key: "all",
      last_video_id: fixture.videoId,
      processed_count: 1,
      total_count: 3,
    });

    const bulk = await ctx!.authInject({
      method: "POST",
      url: "/api/triage/bulk-actions",
      payload: {
        videoIds: [fixture.videoId],
        actions: {
          addTagIds: [tagId],
        },
      },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json().data).toMatchObject({
      processed: 1,
      errors: 0,
      details: {
        tags_added: 1,
      },
    });

    const stats = await ctx!.authInject({
      method: "GET",
      url: "/api/triage/stats",
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().data).toHaveProperty("total_videos");

    const legacy = await ctx!.authInject({
      method: "GET",
      url: "/api/users/triage-progress?filterKey=all",
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.headers.deprecation).toBe("true");
  });

  it("covers stats current, history, snapshot, all-snapshot, and legacy snapshot endpoints", async () => {
    await seedVideoFixture("stats-target.mp4");

    for (const path of ["/storage", "/library", "/content", "/usage"]) {
      const current = await ctx!.authInject({
        method: "GET",
        url: `/api/stats${path}`,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({ success: true });

      const snapshot = await ctx!.authInject({
        method: "POST",
        url: `/api/stats${path}-snapshots`,
      });
      expect(snapshot.statusCode).toBe(201);
      expect(snapshot.json()).toMatchObject({ success: true });

      const history = await ctx!.authInject({
        method: "GET",
        url: `/api/stats${path}/history?days=30&limit=10`,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({ success: true });

      const legacySnapshot = await ctx!.authInject({
        method: "POST",
        url: `/api/stats${path}/snapshot`,
      });
      expect(legacySnapshot.statusCode).toBe(201);
      expect(legacySnapshot.headers.deprecation).toBe("true");
    }

    const allSnapshots = await ctx!.authInject({
      method: "POST",
      url: "/api/stats/snapshots",
    });
    expect(allSnapshots.statusCode).toBe(201);
    expect(allSnapshots.json().data).toHaveProperty("storage");
    expect(allSnapshots.json().data).toHaveProperty("library");
    expect(allSnapshots.json().data).toHaveProperty("content");
    expect(allSnapshots.json().data).toHaveProperty("usage");

    const legacyAllSnapshots = await ctx!.authInject({
      method: "POST",
      url: "/api/stats/snapshot",
    });
    expect(legacyAllSnapshots.statusCode).toBe(201);
    expect(legacyAllSnapshots.headers.deprecation).toBe("true");
  });

  it("covers tagging rule CRUD, test, dry-run apply, and bulk delete", async () => {
    const fixture = await seedVideoFixture("tagging-rule-target.mp4");
    const tagResponse = await ctx!.authInject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Auto Tag Target" },
    });
    expect(tagResponse.statusCode).toBe(201);
    const tagId = tagResponse.json().data.id as number;

    const create = await ctx!.authInject({
      method: "POST",
      url: "/api/tagging-rules",
      payload: {
        name: "Integration Tagging Rule",
        description: "Matches seeded video path",
        rule_type: "path_match",
        is_enabled: true,
        priority: 1,
        conditions: [
          {
            condition_type: "file_pattern",
            operator: "contains",
            value: "tagging-rule-target",
          },
        ],
        actions: [
          {
            action_type: "add_tag",
            target_id: tagId,
          },
        ],
      },
    });
    expect(create.statusCode).toBe(201);
    const rule = create.json().data as { id: number };

    const list = await ctx!.authInject({
      method: "GET",
      url: "/api/tagging-rules?include_disabled=true",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rule.id })]),
    );

    const read = await ctx!.authInject({
      method: "GET",
      url: `/api/tagging-rules/${rule.id}`,
    });
    expect(read.statusCode).toBe(200);

    const update = await ctx!.authInject({
      method: "PATCH",
      url: `/api/tagging-rules/${rule.id}`,
      payload: {
        priority: 2,
        conditions: [
          {
            condition_type: "path_pattern",
            operator: "contains",
            value: "tagging-rule-target",
          },
        ],
        actions: [
          {
            action_type: "add_tag",
            target_id: tagId,
            target_name: "Replacement Action",
          },
        ],
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.priority).toBe(2);

    // The PATCH replaces child rows: GET must return only the new
    // condition/action with no stale rows from the original create.
    const afterUpdate = await ctx!.authInject({
      method: "GET",
      url: `/api/tagging-rules/${rule.id}`,
    });
    expect(afterUpdate.statusCode).toBe(200);
    const updatedRule = afterUpdate.json().data as {
      conditions: Array<{ condition_type: string; value: string }>;
      actions: Array<{ action_type: string; target_name: string | null }>;
    };
    expect(updatedRule.conditions).toEqual([
      expect.objectContaining({
        condition_type: "path_pattern",
        value: "tagging-rule-target",
      }),
    ]);
    expect(updatedRule.actions).toEqual([
      expect.objectContaining({
        action_type: "add_tag",
        target_name: "Replacement Action",
      }),
    ]);

    const test = await ctx!.authInject({
      method: "POST",
      url: `/api/tagging-rules/${rule.id}/test?limit=100`,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json().data.sample_matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ video_id: fixture.videoId }),
      ]),
    );

    const apply = await ctx!.authInject({
      method: "POST",
      url: "/api/tagging-rules/apply",
      payload: {
        video_ids: [fixture.videoId],
        dry_run: true,
        limit: 10,
      },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().data.processed).toBeGreaterThanOrEqual(1);

    const bulkDelete = await ctx!.authInject({
      method: "POST",
      url: "/api/tagging-rules/bulk/delete",
      payload: {
        ids: [rule.id],
      },
    });
    expect(bulkDelete.statusCode).toBe(200);
    expect(bulkDelete.json().data.deleted).toBe(1);
  });

  it("covers mocked conversion, thumbnail, storyboard, backup, edit, event, and remote endpoints", async () => {
    const fixture = await seedVideoFixture("mocked-external-routes.mp4");

    const createConversion = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/conversions`,
      payload: {
        preset: "720p_h264",
        deleteOriginal: false,
      },
    });
    expect(createConversion.statusCode).toBe(201);
    expect(createConversion.json().data).toMatchObject({
      video_id: fixture.videoId,
      preset: "720p_h264",
    });

    const legacyConversion = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/convert`,
      payload: {
        preset: "720p_h264",
      },
    });
    expect(legacyConversion.statusCode).toBe(201);
    expect(legacyConversion.headers.deprecation).toBe("true");

    const bulkConversion = await ctx!.authInject({
      method: "POST",
      url: "/api/conversions",
      payload: {
        videoIds: [fixture.videoId],
        preset: "720p_h264",
      },
    });
    expect(bulkConversion.statusCode).toBe(201);

    for (const response of [
      await ctx!.authInject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/conversions`,
      }),
      await ctx!.authInject({ method: "GET", url: "/api/conversions/queue" }),
      await ctx!.authInject({ method: "GET", url: "/api/conversions/history" }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/conversions/history/overview",
      }),
      await ctx!.authInject({ method: "GET", url: "/api/conversions/1" }),
      await ctx!.authInject({ method: "GET", url: "/api/conversions/active" }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/conversions/queue/status",
      }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/conversion/status",
      }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/conversions/presets",
      }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/presets",
      }),
    ]) {
      expect(response.statusCode).toBe(200);
    }

    const cancel = await ctx!.authInject({
      method: "PATCH",
      url: "/api/conversions/1",
      payload: { status: "cancelled" },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe("cancelled");

    const legacyCancel = await ctx!.authInject({
      method: "POST",
      url: "/api/conversions/1/cancel",
    });
    expect(legacyCancel.statusCode).toBe(200);
    expect(legacyCancel.headers.deprecation).toBe("true");

    const download = await ctx!.authInject({
      method: "GET",
      url: "/api/conversions/1/download",
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("video/x-matroska");

    const clearQueue = await ctx!.authInject({
      method: "POST",
      url: "/api/conversions/queue/clear",
    });
    expect(clearQueue.statusCode).toBe(200);

    const deleteConversion = await ctx!.authInject({
      method: "DELETE",
      url: "/api/conversions/1",
    });
    expect(deleteConversion.statusCode).toBe(200);

    const thumbnailCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/thumbnails`,
      payload: { timestamp: 5 },
    });
    expect(thumbnailCreate.statusCode).toBe(201);
    expect(thumbnailCreate.json().data.asset_url).toBe(
      "/api/thumbnails/1/image",
    );

    for (const response of [
      await ctx!.authInject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/thumbnails`,
      }),
      await ctx!.authInject({ method: "GET", url: "/api/thumbnails/1" }),
      await ctx!.authInject({ method: "GET", url: "/api/thumbnails/1/image" }),
    ]) {
      expect(response.statusCode).toBe(200);
    }

    const thumbnailDelete = await ctx!.authInject({
      method: "DELETE",
      url: "/api/thumbnails/1",
    });
    expect(thumbnailDelete.statusCode).toBe(200);

    const storyboardCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/storyboard`,
      payload: {
        tileWidth: 160,
        tileHeight: 90,
        intervalSeconds: 10,
      },
    });
    expect(storyboardCreate.statusCode).toBe(201);
    expect(storyboardCreate.json().data.vtt_url).toBe(
      `/api/videos/${fixture.videoId}/thumbnails.vtt`,
    );

    for (const response of [
      await ctx!.authInject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/storyboard`,
      }),
      await ctx!.inject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/thumbnails.vtt`,
      }),
      await ctx!.inject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/storyboard.jpg`,
      }),
      await ctx!.inject({
        method: "GET",
        url: `/api/videos/${fixture.videoId}/storyboard.webp`,
      }),
    ]) {
      expect(response.statusCode).toBe(200);
    }

    const storyboardDelete = await ctx!.authInject({
      method: "DELETE",
      url: `/api/videos/${fixture.videoId}/storyboard`,
    });
    expect(storyboardDelete.statusCode).toBe(200);

    const backupCreate = await ctx!.authInject({
      method: "POST",
      url: "/api/backup",
    });
    expect(backupCreate.statusCode).toBe(201);

    for (const response of [
      await ctx!.authInject({ method: "GET", url: "/api/backup" }),
      await ctx!.authInject({ method: "GET", url: "/api/backup/export" }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/backup/backup-test.json/restore",
      }),
      await ctx!.authInject({
        method: "DELETE",
        url: "/api/backup/backup-test.json",
      }),
    ]) {
      expect(response.statusCode).toBe(200);
    }

    const editMetadata = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}/editing-metadata`,
    });
    expect(editMetadata.statusCode).toBe(200);
    expect(editMetadata.json().data.audio).toMatchObject({
      channels: 2,
      sample_rate: 48000,
    });

    const editCreate = await ctx!.authInject({
      method: "POST",
      url: `/api/videos/${fixture.videoId}/edits`,
      payload: {
        output: {
          directory_id: fixture.directoryId,
          file_name: "edited.mkv",
        },
        timeline: {
          segments: [{ start: 0, end: 10 }],
        },
      },
    });
    expect(editCreate.statusCode).toBe(202);
    expect(editCreate.headers.location).toBe("/api/edits/jobs/1");
    expect(editCreate.json().data.status).toBe("queued");

    const editJobs = await ctx!.authInject({
      method: "GET",
      url: `/api/edits/jobs?video_id=${fixture.videoId}&status=completed`,
    });
    expect(editJobs.statusCode).toBe(200);
    expect(editJobs.json()).toMatchObject({
      data: [
        {
          job_id: 1,
          video_id: 1,
          status: "completed",
          output: {
            video_id: 2,
            stream_url: "/api/videos/2/stream",
          },
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const editStatus = await ctx!.authInject({
      method: "GET",
      url: "/api/edits/jobs/1",
    });
    expect(editStatus.statusCode).toBe(200);
    expect(editStatus.json().data.status).toBe("completed");
    expect(editStatus.json().data.output.stream_url).toBe(
      "/api/videos/2/stream",
    );

    const editingPaths = ctx!.app.swagger().paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    expect(editingPaths["/api/videos/{id}/edits"]?.post?.responses).toEqual(
      expect.objectContaining({
        "202": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "409": expect.anything(),
        "500": expect.anything(),
      }),
    );
    expect(editingPaths["/api/edits/jobs"]?.get?.responses).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "500": expect.anything(),
      }),
    );

    const editCancel = await ctx!.authInject({
      method: "POST",
      url: "/api/edits/jobs/1/cancel",
    });
    expect(editCancel.statusCode).toBe(200);
    expect(editCancel.json().data.status).toBe("cancelled");

    const events = await ctx!.authInject({
      method: "GET",
      url: "/api/events/stream",
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");

    const displayDevice = await ctx!.authInject({
      method: "POST",
      url: "/api/multiplayer-remote/display-devices",
      payload: {
        deviceName: "Display",
        deviceType: "desktop",
      },
    });
    expect(displayDevice.statusCode).toBe(201);

    const remoteDeviceKey = "r".repeat(32);
    const remoteSession = await ctx!.authInject({
      method: "POST",
      url: "/api/multiplayer-remote/sessions",
    });
    expect(remoteSession.statusCode).toBe(201);

    for (const response of [
      await ctx!.authInject({
        method: "GET",
        url: "/api/multiplayer-remote/sessions/1",
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/pair",
        payload: {
          pairingCode: "ABC123",
          remoteDeviceKey,
          remoteDeviceName: "Remote",
          remoteDeviceType: "mobile",
        },
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/trusted-devices/discover",
        payload: {
          remoteDeviceKey,
          remoteDeviceName: "Remote",
          remoteDeviceType: "mobile",
        },
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/sessions/1/trusted-connect",
        payload: {
          remoteDeviceKey,
          remoteDeviceName: "Remote",
          remoteDeviceType: "mobile",
        },
      }),
      await ctx!.authInject({
        method: "GET",
        url: "/api/multiplayer-remote/sessions/1/join-requests/pending",
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/sessions/1/join-requests/1/approve",
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/sessions/1/join-requests/1/reject",
      }),
      await ctx!.authInject({
        method: "POST",
        url: "/api/multiplayer-remote/sessions/1/close",
        payload: { reason: "integration complete" },
      }),
    ]) {
      expect(response.statusCode).toBe(200);
    }
  });
});
