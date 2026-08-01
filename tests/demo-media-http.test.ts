import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import multipart from "@fastify/multipart";
import { eq, inArray } from "drizzle-orm";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-media-http-test";
process.env.POSTGRES_PASSWORD ||= "demo-media-http-test";
process.env.SESSION_SECRET ||=
  "demo-media-http-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const databasePath = `/tmp/conversor-video-demo-media-${process.pid}.sqlite`;

function multipartImage() {
  const boundary = `----codex-demo-media-${process.pid}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

describe("demo media HTTP contracts and asset isolation", () => {
  const app = Fastify({ logger: false });
  const assetsRoot = mkdtempSync(
    join(tmpdir(), "conversor-video-demo-assets-")
  );
  const outsidePath = `${assetsRoot}-outside.png`;
  const sourcePath = join(assetsRoot, "seed", "source.bin");
  let originalDemoMode: boolean;
  let originalAssetsDir: string;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    originalAssetsDir = env.DEMO_ASSETS_DIR;
    env.DEMO_MODE = true;
    env.DEMO_ASSETS_DIR = assetsRoot;

    mkdirSync(join(assetsRoot, "seed"), { recursive: true });
    writeFileSync(sourcePath, Buffer.from("not-a-real-video"));
    writeFileSync(outsidePath, PNG);

    const {
      demoSchema,
      getDemoDatabase,
      initializeDemoDatabase,
      setDemoDatabasePathForTests,
    } = await import("@/database/demo");
    setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    initializeDemoDatabase();
    const now = new Date().toISOString();
    const db = getDemoDatabase();
    db.insert(demoSchema.demoCreatorsTable)
      .values({
        id: 1,
        name: "Demo Creator",
        description: null,
        profilePicturePath: null,
        mainPicturePath: null,
        faceThumbnailPath: null,
        extraJson: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(demoSchema.demoStudiosTable)
      .values({
        id: 1,
        name: "Demo Studio",
        description: null,
        profilePicturePath: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(demoSchema.demoTagsTable)
      .values({
        id: 1,
        name: "Demo Tag",
        parentId: null,
        description: null,
        color: "#64748b",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(demoSchema.demoVideosTable)
      .values({
        id: 1,
        sourceVideoId: 1,
        filePath: sourcePath,
        fileName: "source.bin",
        directoryId: 1,
        fileSizeBytes: readFileSync(sourcePath).length,
        fileHash: null,
        durationSeconds: 30,
        width: 640,
        height: 360,
        codec: "demo",
        bitrate: 1,
        fps: 30,
        audioCodec: "demo",
        title: "Demo video",
        description: null,
        themes: null,
        isAvailable: true,
        lastVerifiedAt: now,
        indexedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart, {
      limits: { files: 1, fileSize: 1024 * 1024 },
    });
    const { AppError } = await import("@/utils/errors");
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          success: false,
          error: { message: error.message, statusCode: error.statusCode },
        });
      }
      return reply.send(error);
    });

    const { creatorsRoutes } =
      await import("@/modules/creators/creators.routes");
    const { studiosRoutes } = await import("@/modules/studios/studios.routes");
    const { videosRoutes } = await import("@/modules/videos/videos.routes");
    const { videoThumbnailsRoutes, thumbnailsRoutes } =
      await import("@/modules/thumbnails/thumbnails.routes");
    const { storyboardsRoutes } =
      await import("@/modules/storyboards/storyboards.routes");
    const { videoArtworkRoutes, artworkRoutes } =
      await import("@/modules/artwork/artwork.routes");
    await app.register(creatorsRoutes, { prefix: "/api/creators" });
    await app.register(studiosRoutes, { prefix: "/api/studios" });
    await app.register(videosRoutes, { prefix: "/api/videos" });
    await app.register(videoThumbnailsRoutes, { prefix: "/api/videos" });
    await app.register(thumbnailsRoutes, { prefix: "/api/thumbnails" });
    await app.register(storyboardsRoutes, { prefix: "/api/videos" });
    await app.register(videoArtworkRoutes, { prefix: "/api/videos" });
    await app.register(artworkRoutes, { prefix: "/api/artwork" });
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
    rmSync(assetsRoot, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
    env.DEMO_ASSETS_DIR = originalAssetsDir;
  });

  it("simulates creator picture and gallery routes without fetching URLs", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/creators/1/picture",
      ...multipartImage(),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const picturePath = upload.json().data.profile_picture_path as string;
    expect(isWithin(join(assetsRoot, "runtime"), picturePath)).toBe(true);
    expect(existsSync(picturePath)).toBe(true);

    const picture = await app.inject({
      method: "GET",
      url: "/api/creators/1/picture",
    });
    expect(picture.statusCode, picture.body).toBe(200);
    expect(picture.headers["content-type"]).toContain("image/png");

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("demo URL simulation must not fetch");
    }) as unknown as typeof fetch;
    try {
      const fromUrl = await app.inject({
        method: "POST",
        url: "/api/creators/1/picture-from-url",
        payload: { url: "https://example.test/creator.png", variant: "main" },
      });
      expect(fromUrl.statusCode, fromUrl.body).toBe(200);

      const galleryFromUrl = await app.inject({
        method: "POST",
        url: "/api/creators/1/gallery-from-url",
        payload: {
          url: "https://example.test/gallery.png",
          label: "Simulated",
        },
      });
      expect(galleryFromUrl.statusCode, galleryFromUrl.body).toBe(201);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/creators/1/picture-from-url",
      payload: { url: "file:///etc/passwd" },
    });
    expect(unsafe.statusCode, unsafe.body).toBe(400);

    const galleryUpload = await app.inject({
      method: "POST",
      url: "/api/creators/1/gallery",
      ...multipartImage(),
    });
    expect(galleryUpload.statusCode, galleryUpload.body).toBe(201);
    const gallery = galleryUpload.json().data as {
      id: number;
      file_path: string;
    };
    expect(existsSync(gallery.file_path)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/creators/1/gallery",
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.length).toBeGreaterThanOrEqual(4);

    const image = await app.inject({
      method: "GET",
      url: `/api/creators/1/gallery/${gallery.id}/image`,
    });
    expect(image.statusCode, image.body).toBe(200);

    const roles = await app.inject({
      method: "PATCH",
      url: `/api/creators/1/gallery/${gallery.id}`,
      payload: { is_profile_picture: true },
    });
    expect(roles.statusCode, roles.body).toBe(200);
    expect(roles.json().data.is_profile_picture).toBe(true);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/creators/1/gallery/${gallery.id}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);
    expect(existsSync(gallery.file_path)).toBe(false);

    for (const url of [
      "/api/creators/1/picture?variant=main",
      "/api/creators/1/picture",
    ]) {
      const response = await app.inject({ method: "DELETE", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
  });

  it("simulates studio picture upload, serving, URL assignment, and cleanup", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/studios/1/picture",
      ...multipartImage(),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const firstPath = upload.json().data.profile_picture_path as string;
    expect(existsSync(firstPath)).toBe(true);

    const image = await app.inject({
      method: "GET",
      url: "/api/studios/1/picture",
    });
    expect(image.statusCode, image.body).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");

    const fromUrl = await app.inject({
      method: "POST",
      url: "/api/studios/1/picture-from-url",
      payload: { url: "https://example.test/studio.png" },
    });
    expect(fromUrl.statusCode, fromUrl.body).toBe(200);
    const currentPath = fromUrl.json().data.profile_picture_path as string;
    expect(existsSync(currentPath)).toBe(true);

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/studios/1/picture",
    });
    expect(remove.statusCode, remove.body).toBe(200);
    expect(existsSync(currentPath)).toBe(false);
  });

  it("serves complete thumbnail, storyboard, and artwork lifecycles", async () => {
    const thumbnail = await app.inject({
      method: "POST",
      url: "/api/videos/1/thumbnails",
      payload: { positionPercent: 25 },
    });
    expect(thumbnail.statusCode, thumbnail.body).toBe(201);
    const thumbnailId = thumbnail.json().data.id as number;
    const thumbnailPath = thumbnail.json().data.file_path as string;
    expect(existsSync(thumbnailPath)).toBe(true);

    for (const url of [
      "/api/videos/1/thumbnails",
      `/api/thumbnails/${thumbnailId}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    const thumbnailImage = await app.inject({
      method: "GET",
      url: `/api/thumbnails/${thumbnailId}/image`,
    });
    expect(thumbnailImage.statusCode, thumbnailImage.body).toBe(200);
    expect(thumbnailImage.headers["content-type"]).toContain("image/png");
    const thumbnailDelete = await app.inject({
      method: "DELETE",
      url: `/api/thumbnails/${thumbnailId}`,
    });
    expect(thumbnailDelete.statusCode, thumbnailDelete.body).toBe(200);
    expect(existsSync(thumbnailPath)).toBe(false);

    const storyboard = await app.inject({
      method: "POST",
      url: "/api/videos/1/storyboard",
      payload: { intervalSeconds: 5, tileWidth: 160, tileHeight: 90 },
    });
    expect(storyboard.statusCode, storyboard.body).toBe(201);
    const spritePath = storyboard.json().data.sprite_path as string;
    const vttPath = storyboard.json().data.vtt_path as string;
    for (const url of [
      "/api/videos/1/storyboard",
      "/api/videos/1/thumbnails.vtt",
      "/api/videos/1/storyboard.jpg",
      "/api/videos/1/storyboard.webp",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    const storyboardDelete = await app.inject({
      method: "DELETE",
      url: "/api/videos/1/storyboard",
    });
    expect(storyboardDelete.statusCode, storyboardDelete.body).toBe(200);
    expect(existsSync(spritePath)).toBe(false);
    expect(existsSync(vttPath)).toBe(false);

    const artwork = await app.inject({
      method: "POST",
      url: "/api/videos/1/artwork",
      payload: { variants: ["card", "title"] },
    });
    expect(artwork.statusCode, artwork.body).toBe(202);
    const assets = artwork.json().data.assets as Array<{
      id: number;
      url: string;
    }>;
    expect(assets).toHaveLength(2);

    const artworkGet = await app.inject({
      method: "GET",
      url: "/api/videos/1/artwork",
    });
    expect(artworkGet.statusCode, artworkGet.body).toBe(200);
    const artworkImage = await app.inject({
      method: "GET",
      url: `/api/artwork/${assets[0].id}/image`,
    });
    expect(artworkImage.statusCode, artworkImage.body).toBe(200);
    expect(artworkImage.headers["content-type"]).toContain("image/png");

    const artworkDelete = await app.inject({
      method: "DELETE",
      url: "/api/videos/1/artwork",
    });
    expect(artworkDelete.statusCode, artworkDelete.body).toBe(200);
    const absent = await app.inject({
      method: "GET",
      url: "/api/videos/1/artwork",
    });
    expect(absent.statusCode, absent.body).toBe(200);
    expect(absent.json().data.status).toBe("absent");

    const batch = await app.inject({
      method: "POST",
      url: "/api/artwork/batch",
      payload: { video_ids: [1], variants: ["poster"] },
    });
    expect(batch.statusCode, batch.body).toBe(202);
    expect(batch.json().data).toEqual({ queued: 1, video_ids: [1] });
  });

  it("verifies, refreshes, conditionally applies, and safely replaces video files", async () => {
    const verify = await app.inject({
      method: "POST",
      url: "/api/videos/1/verify",
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json().data.is_available).toBe(true);

    const refresh = await app.inject({
      method: "POST",
      url: "/api/videos/1/refresh",
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    expect(refresh.json().data.file_size_bytes).toBe(
      readFileSync(sourcePath).length
    );
    const initialContentHash = refresh.json().data.file_hash;
    expect(initialContentHash).toBeString();
    writeFileSync(sourcePath, Buffer.from("same-path-updated-content"));
    const refreshedAgain = await app.inject({
      method: "POST",
      url: "/api/videos/1/refresh",
    });
    expect(refreshedAgain.statusCode, refreshedAgain.body).toBe(200);
    expect(refreshedAgain.json().data.file_hash).not.toBe(initialContentHash);
    expect(existsSync(join(assetsRoot, "runtime", "thumbnails"))).toBe(true);

    const conditional = await app.inject({
      method: "POST",
      url: "/api/videos/bulk/conditional-apply",
      payload: {
        filter: { ids: [1] },
        actions: { addCreatorIds: [1], addTagIds: [1], addStudioIds: [1] },
      },
    });
    expect(conditional.statusCode, conditional.body).toBe(200);
    expect(conditional.json().data).toMatchObject({
      matched: 1,
      affected: 1,
      errors: 0,
      details: { creators_added: 1, tags_added: 1, studios_added: 1 },
    });

    const replacementPath = join(
      assetsRoot,
      "runtime",
      "replacements",
      "replacement.bin"
    );
    mkdirSync(join(assetsRoot, "runtime", "replacements"), { recursive: true });
    writeFileSync(replacementPath, Buffer.from("replacement"));
    const { videosService } = await import("@/modules/videos/videos.service");
    const replaced = await videosService.replaceFile(1, replacementPath);
    expect(replaced.file_path).toBe(replacementPath);
    expect(replaced.file_hash).not.toBe(refreshedAgain.json().data.file_hash);
    await expect(videosService.replaceFile(1, sourcePath)).rejects.toThrow(
      "inside DEMO_ASSETS_DIR/runtime"
    );
  });

  it("marks one missing video unavailable without verifying any sibling", async () => {
    const { demoSchema, getDemoDatabase } = await import("@/database/demo");
    const db = getDemoDatabase();
    const timestamp = new Date().toISOString();
    const untouchedAt = "2026-07-01T00:00:00.000Z";
    const missingPath = join(assetsRoot, "seed", "missing-video.bin");

    db.insert(demoSchema.demoVideosTable)
      .values({
        id: 2,
        sourceVideoId: 2,
        filePath: missingPath,
        fileName: "missing-video.bin",
        directoryId: 2,
        fileSizeBytes: 123,
        fileHash: null,
        durationSeconds: 10,
        width: 320,
        height: 180,
        codec: "demo",
        bitrate: 1,
        fps: 24,
        audioCodec: "demo",
        title: "Missing demo video",
        description: null,
        themes: null,
        isAvailable: true,
        lastVerifiedAt: timestamp,
        indexedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    db.update(demoSchema.demoVideosTable)
      .set({ isAvailable: false, lastVerifiedAt: untouchedAt })
      .where(eq(demoSchema.demoVideosTable.id, 1))
      .run();

    const response = await app.inject({
      method: "POST",
      url: "/api/videos/2/verify",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.is_available).toBe(false);

    const missing = db
      .select()
      .from(demoSchema.demoVideosTable)
      .where(eq(demoSchema.demoVideosTable.id, 2))
      .get()!;
    const untouched = db
      .select()
      .from(demoSchema.demoVideosTable)
      .where(eq(demoSchema.demoVideosTable.id, 1))
      .get()!;
    expect(missing.isAvailable).toBe(false);
    expect(missing.lastVerifiedAt).not.toBe(timestamp);
    expect(untouched.isAvailable).toBe(false);
    expect(untouched.lastVerifiedAt).toBe(untouchedAt);

    db.delete(demoSchema.demoVideosTable)
      .where(eq(demoSchema.demoVideosTable.id, 2))
      .run();
    db.update(demoSchema.demoVideosTable)
      .set({ isAvailable: true })
      .where(eq(demoSchema.demoVideosTable.id, 1))
      .run();
  });

  it("purges runtime-derived artifacts while preserving every seeded file", async () => {
    const { demoRepository, demoSchema, getDemoDatabase } =
      await import("@/database/demo");
    const { demoMediaAssetsService } =
      await import("@/modules/media/demo-media-assets.service");
    const db = getDemoDatabase();
    const timestamp = new Date().toISOString();
    const seedDirectory = join(assetsRoot, "seed", "purge");
    const runtimeFaces = join(assetsRoot, "runtime", "faces");
    mkdirSync(seedDirectory, { recursive: true });
    mkdirSync(runtimeFaces, { recursive: true });

    const runtimeSource = join(seedDirectory, "runtime-artifacts-source.bin");
    const seededSource = join(seedDirectory, "seeded-artifacts-source.bin");
    const seededThumbnail = join(seedDirectory, "thumbnail.png");
    const seededSprite = join(seedDirectory, "storyboard.png");
    const seededVtt = join(seedDirectory, "storyboard.vtt");
    const seededArtwork = join(seedDirectory, "artwork.png");
    const seededFace = join(seedDirectory, "face.png");
    const runtimeFace = join(runtimeFaces, "detection-300.png");
    for (const path of [
      runtimeSource,
      seededSource,
      seededThumbnail,
      seededSprite,
      seededArtwork,
      seededFace,
      runtimeFace,
    ]) {
      writeFileSync(path, PNG);
    }
    writeFileSync(seededVtt, "WEBVTT\n");
    const linkedSeedDirectory = join(assetsRoot, "runtime", "seed-link");
    symlinkSync(seedDirectory, linkedSeedDirectory);
    const seededFaceThroughRuntimeLink = join(linkedSeedDirectory, "face.png");

    const insertVideo = (id: number, filePath: string) =>
      db
        .insert(demoSchema.demoVideosTable)
        .values({
          id,
          sourceVideoId: id,
          filePath,
          fileName: filePath.split("/").at(-1)!,
          directoryId: id,
          fileSizeBytes: readFileSync(filePath).length,
          fileHash: null,
          durationSeconds: 20,
          width: 640,
          height: 360,
          codec: "demo",
          bitrate: 1,
          fps: 30,
          audioCodec: "demo",
          title: `Purge fixture ${id}`,
          description: null,
          themes: null,
          isAvailable: true,
          lastVerifiedAt: timestamp,
          indexedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    insertVideo(3, runtimeSource);
    insertVideo(4, seededSource);

    demoMediaAssetsService.generateThumbnail(3);
    demoMediaAssetsService.generateStoryboard(3);
    demoMediaAssetsService.generateArtwork(3, { variants: ["poster"] });
    const runtimeThumbnail = db
      .select()
      .from(demoSchema.demoThumbnailsTable)
      .where(eq(demoSchema.demoThumbnailsTable.videoId, 3))
      .get()!.filePath;
    const runtimeStoryboard = db
      .select()
      .from(demoSchema.demoStoryboardsTable)
      .where(eq(demoSchema.demoStoryboardsTable.videoId, 3))
      .get()!;
    const runtimeArtwork = db
      .select()
      .from(demoSchema.demoArtworkAssetsTable)
      .where(eq(demoSchema.demoArtworkAssetsTable.videoId, 3))
      .get()!.filePath;

    db.insert(demoSchema.demoThumbnailsTable)
      .values({
        videoId: 4,
        filePath: seededThumbnail,
        fileSizeBytes: readFileSync(seededThumbnail).length,
        timestampSeconds: 0,
        width: 1,
        height: 1,
        generatedAt: timestamp,
      })
      .run();
    db.insert(demoSchema.demoStoryboardsTable)
      .values({
        videoId: 4,
        spritePath: seededSprite,
        vttPath: seededVtt,
        tileWidth: 1,
        tileHeight: 1,
        tileCount: 1,
        intervalSeconds: 10,
        spriteSizeBytes: readFileSync(seededSprite).length,
        generatedAt: timestamp,
      })
      .run();
    db.insert(demoSchema.demoArtworkTable)
      .values({
        videoId: 4,
        title: "Seeded artwork",
        status: "ready",
        paletteJson: null,
        generatedAt: timestamp,
      })
      .run();
    db.insert(demoSchema.demoArtworkAssetsTable)
      .values({
        id: 44,
        videoId: 4,
        variant: "hero",
        contentHash: "seeded-artwork",
        filePath: seededArtwork,
        fileSizeBytes: readFileSync(seededArtwork).length,
        width: 1,
        height: 1,
        sourceTimestampSeconds: null,
        cropJson: null,
        focalPointJson: null,
        safeAreaJson: null,
        bottomLuma: null,
        thumbhash: null,
        effectsJson: "[]",
        generatedAt: timestamp,
      })
      .run();

    demoRepository.putResource("face-detection", 300, {
      id: 300,
      videoId: 3,
    });
    demoRepository.putResource("face-image", 300, {
      id: 300,
      detectionId: 300,
      filePath: runtimeFace,
    });
    demoRepository.putResource("face-extraction-job", 3, {
      id: 3,
      videoId: 3,
    });
    demoRepository.putResource("face-detection", 400, {
      id: 400,
      videoId: 4,
    });
    demoRepository.putResource("face-image", 400, {
      id: 400,
      detectionId: 400,
      filePath: seededFaceThroughRuntimeLink,
    });

    db.update(demoSchema.demoVideosTable)
      .set({ isAvailable: false })
      .where(inArray(demoSchema.demoVideosTable.id, [3, 4]))
      .run();
    const response = await app.inject({
      method: "POST",
      url: "/api/videos/unavailable/cleanup",
      payload: { ids: [3, 4] },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().deleted_ids.sort()).toEqual([3, 4]);

    for (const path of [
      runtimeThumbnail,
      runtimeStoryboard.spritePath,
      runtimeStoryboard.vttPath,
      runtimeArtwork,
      runtimeFace,
    ]) {
      expect(existsSync(path), `runtime artifact leaked: ${path}`).toBe(false);
    }
    for (const path of [
      runtimeSource,
      seededSource,
      seededThumbnail,
      seededSprite,
      seededVtt,
      seededArtwork,
      seededFace,
    ]) {
      expect(existsSync(path), `seeded asset was deleted: ${path}`).toBe(true);
    }
    expect(
      db
        .select()
        .from(demoSchema.demoVideosTable)
        .where(inArray(demoSchema.demoVideosTable.id, [3, 4]))
        .all()
    ).toEqual([]);
    expect(
      db
        .select()
        .from(demoSchema.demoResourcesTable)
        .where(
          inArray(demoSchema.demoResourcesTable.kind, [
            "face-detection",
            "face-image",
            "face-extraction-job",
          ])
        )
        .all()
    ).toEqual([]);
  });

  it("rejects gallery symlink escapes and resets only runtime assets", async () => {
    const gallery = await app.inject({
      method: "POST",
      url: "/api/creators/1/gallery-from-url",
      payload: { url: "https://example.test/escape.png" },
    });
    expect(gallery.statusCode, gallery.body).toBe(201);
    const mediaId = gallery.json().data.id as number;
    const linkPath = join(
      assetsRoot,
      "runtime",
      "creator-gallery",
      "escape.png"
    );
    symlinkSync(outsidePath, linkPath);

    const { demoSchema, getDemoDatabase } = await import("@/database/demo");
    getDemoDatabase()
      .update(demoSchema.demoCreatorGalleryTable)
      .set({ filePath: linkPath })
      .where(eq(demoSchema.demoCreatorGalleryTable.id, mediaId))
      .run();
    const escaped = await app.inject({
      method: "GET",
      url: `/api/creators/1/gallery/${mediaId}/image`,
    });
    expect(escaped.statusCode).not.toBe(200);

    const keepPath = join(assetsRoot, "seed", "keep.bin");
    writeFileSync(keepPath, Buffer.from("keep"));
    const { demoMediaAssetsService } =
      await import("@/modules/media/demo-media-assets.service");
    demoMediaAssetsService.resetRuntimeAssets();
    expect(existsSync(keepPath)).toBe(true);
    expect(existsSync(outsidePath)).toBe(true);
    expect(existsSync(join(assetsRoot, "runtime"))).toBe(true);
    expect(readdirSync(join(assetsRoot, "runtime"))).toEqual([]);
  });
});
