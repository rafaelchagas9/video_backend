import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { access, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import sharp from "sharp";
import type { TestApp } from "../helpers/test-app";
import { createTestApp, seedVideoFixture } from "../helpers/test-app";

describe("Artwork API integration", () => {
  let ctx: TestApp | undefined;
  let tempDir: string | undefined;
  let videoId: number;
  let assetId: number;
  const contentHash = "0123456789abcdef";

  beforeAll(async () => {
    ctx = await createTestApp();
    tempDir = await mkdtemp(join(tmpdir(), "conversor-video-artwork-"));
    const fixture = await seedVideoFixture("artwork-fixture.mp4");
    videoId = fixture.videoId;
    const filePath = join(tempDir, `card-${contentHash}.webp`);
    await sharp({
      create: {
        width: 160,
        height: 90,
        channels: 3,
        background: { r: 120, g: 45, b: 25 },
      },
    })
      .webp()
      .toFile(filePath);

    const { db } = await import("@/config/drizzle");
    const { artworkAssetsTable, videoArtworkTable } = await import(
      "@/database/schema"
    );
    await db.insert(videoArtworkTable).values({
      videoId,
      status: "ready",
      palette: {
        dominant: "#782d19",
        swatches: ["#782d19", "#40180d"],
        mean_oklch: { l: 0.42, c: 0.09, h: 41 },
        is_neutral: false,
      },
      generatedAt: new Date(),
    });
    const [asset] = await db
      .insert(artworkAssetsTable)
      .values({
        videoId,
        variant: "card",
        contentHash,
        filePath,
        fileSizeBytes: 128,
        width: 160,
        height: 90,
        sourceTimestampSeconds: 12,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        focalPoint: { x: 0.4, y: 0.3 },
        safeArea: { x: 0.55, y: 0.1, width: 0.4, height: 0.7 },
        bottomLuma: 0.18,
        thumbhash: null,
        effects: [],
      })
      .returning({ id: artworkAssetsTable.id });
    if (!asset) throw new Error("Failed to seed artwork asset");
    assetId = asset.id;
  }, 60_000);

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await ctx?.close();
  });

  it("returns full artwork and compact list summaries", async () => {
    const full = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${videoId}/artwork`,
    });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({
      success: true,
      data: {
        video_id: videoId,
        status: "ready",
        palette: { dominant: "#782d19" },
        assets: [
          {
            id: assetId,
            variant: "card",
            url: `/api/artwork/${assetId}/image?h=${contentHash}`,
          },
        ],
      },
    });

    const list = await ctx!.authInject({
      method: "GET",
      url: `/api/videos?ids=${videoId}&include=artwork`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].artwork).toMatchObject({
      urls: { card: `/api/artwork/${assetId}/image?h=${contentHash}` },
      palette: { dominant: "#782d19" },
      focal_point: { x: 0.4, y: 0.3 },
      bottom_luma: 0.18,
    });
  });

  it("serves resized formats with CORS, immutable caching, and ETag validation", async () => {
    const image = await ctx!.authInject({
      method: "GET",
      url: `/api/artwork/${assetId}/image?h=${contentHash}&w=80&format=png`,
      headers: { origin: "http://localhost:3000" },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(image.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(image.headers.etag).toMatch(/^"[a-f0-9]{24}"$/);
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata.width).toBe(80);
    expect(metadata.height).toBe(45);

    const notModified = await ctx!.authInject({
      method: "GET",
      url: `/api/artwork/${assetId}/image?h=${contentHash}&w=80&format=png`,
      headers: { "if-none-match": image.headers.etag! },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload.byteLength).toBe(0);
  });

  it("skips complete variants during a missing-only batch", async () => {
    const batch = await ctx!.authInject({
      method: "POST",
      url: "/api/artwork/batch",
      payload: {
        filter: { missing_only: true },
        variants: ["card"],
      },
    });
    expect(batch.statusCode).toBe(202);
    expect(batch.json() as unknown).toEqual({
      success: true,
      data: { queued: 0, video_ids: [] },
    });
  });

  it("preserves PNG for title originals and width-only resizes", async () => {
    const titleHash = "fedcba9876543210";
    const titlePath = join(tempDir!, `title-${titleHash}.png`);
    await sharp({
      create: {
        width: 120,
        height: 40,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="120" height="40"><text x="0" y="30" fill="#fff" font-size="30">Title</text></svg>',
          ),
        },
      ])
      .png()
      .toFile(titlePath);

    const { db } = await import("@/config/drizzle");
    const { artworkAssetsTable } = await import("@/database/schema");
    const [titleAsset] = await db
      .insert(artworkAssetsTable)
      .values({
        videoId,
        variant: "title",
        contentHash: titleHash,
        filePath: titlePath,
        fileSizeBytes: 256,
        width: 120,
        height: 40,
        sourceTimestampSeconds: null,
        crop: null,
        focalPoint: null,
        safeArea: null,
        bottomLuma: null,
        thumbhash: null,
        effects: ["title"],
      })
      .returning({ id: artworkAssetsTable.id });
    if (!titleAsset) throw new Error("Failed to seed title artwork asset");

    const original = await ctx!.authInject({
      method: "GET",
      url: `/api/artwork/${titleAsset.id}/image?h=${titleHash}`,
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toContain("image/png");

    const resized = await ctx!.authInject({
      method: "GET",
      url: `/api/artwork/${titleAsset.id}/image?h=${titleHash}&w=60`,
    });
    expect(resized.statusCode).toBe(200);
    expect(resized.headers["content-type"]).toContain("image/png");
    const metadata = await sharp(resized.rawPayload).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 60, height: 20 });
  });

  it("deletes artwork metadata and physical files", async () => {
    const remove = await ctx!.authInject({
      method: "DELETE",
      url: `/api/videos/${videoId}/artwork`,
    });
    expect(remove.statusCode).toBe(200);

    const missing = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${videoId}/artwork`,
    });
    expect(missing.json().data).toMatchObject({ status: "absent", assets: [] });
    await expect(access(join(tempDir!, `card-${contentHash}.webp`))).rejects.toThrow();
  });
});
