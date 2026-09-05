import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoSeedDocument } from "@/database/demo/seed";
import type { DemoArtworkCatalogEntry } from "@/database/demo/artwork";

/** Small synthetic catalog; never reads downloaded assets or personal media. */
export function createDemoFixtureFiles(root: string) {
  mkdirSync(root, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64"
  );
  const image = join(root, "image.png");
  const vtt = join(root, "storyboard.vtt");
  writeFileSync(image, png);
  writeFileSync(
    vtt,
    "WEBVTT\n\n00:00.000 --> 00:10.000\nimage.png#xywh=0,0,1,1\n"
  );
  const socialLinks = [
    { platformName: "Website", url: "https://example.com" },
    { platformName: "Channel", url: "https://example.com/channel" },
  ];
  const document: DemoSeedDocument = {
    tags: Array.from({ length: 46 }, (_, index) => ({
      name:
        ["Live Music", "Live Session", "Tiny Desk"][index] ??
        `Tag ${index + 1}`,
      parentName:
        index === 1 ? "Live Music" : index === 2 ? "Live Session" : null,
      color: "#abcdef",
    })),
    studios: Array.from({ length: 21 }, (_, index) => ({
      name: `Studio ${index + 1}`,
      profilePicturePath: image,
      socialLinks,
    })),
    creators: Array.from({ length: 42 }, (_, index) => ({
      name: `Creator ${index + 1}`,
      profilePicturePath: image,
      mainPicturePath: image,
      faceThumbnailPath: image,
      aliases: [`Artist ${index + 1}`],
      socialLinks,
      platforms: [
        {
          platformName: "Website",
          username: `creator${index + 1}`,
          profileUrl: "https://example.com",
          isPrimary: true,
        },
      ],
      galleryMedia: [
        { label: "Portrait", filePath: image },
        { label: "Still", filePath: image },
      ],
      faceEmbeddings: [
        { detScore: 0.9, isPrimary: true, embedding: "[0.1,0.2]" },
      ],
    })),
    videos: [],
  };
  const entries: Record<string, DemoArtworkCatalogEntry> = {};
  for (let index = 0; index < 44; index++) {
    const title = `Video ${index + 1}`;
    const thumbnail = join(root, `thumbnail-${index + 1}.png`);
    const filePath = join(root, `video-${index + 1}.webm`);
    writeFileSync(thumbnail, png);
    // Catalog tests require a present path, but do not decode these placeholders.
    writeFileSync(filePath, "synthetic catalog fixture");
    document.videos.push({
      filePath,
      fileName: `video-${index + 1}.webm`,
      fileSizeBytes: 25,
      durationSeconds: 600,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: "vp9",
      bitrate: 1000000,
      audioCodec: "opus",
      title,
      creators: [`Creator ${(index % 42) + 1}`],
      studios: index === 43 ? [] : [`Studio ${(index % 21) + 1}`],
      tags: [document.tags[index % 46]!.name],
      thumbnail: {
        filePath: thumbnail,
        timestampSeconds: 5,
        width: 1,
        height: 1,
      },
      storyboard: {
        spritePath: image,
        vttPath: vtt,
        tileWidth: 1,
        tileHeight: 1,
        tileCount: 1,
        intervalSeconds: 10,
      },
    });
    entries[thumbnail] = {
      title,
      palette: {
        dominant: "#abcdef",
        swatches: ["#abcdef"],
        mean_oklch: { l: 0.5, c: 0.1, h: 90 },
        is_neutral: false,
      },
      assets: Object.fromEntries(
        ["card", "poster", "square", "hero", "title"].map((variant) => [
          variant,
          {
            variant,
            content_hash: "0123456789abcdef",
            file_path: image,
            file_size_bytes: png.length,
            width: 1,
            height: 1,
            effects: variant === "title" ? ["title"] : [],
          },
        ])
      ),
    };
  }
  const seedPath = join(root, "demo_mode.json");
  const manifestPath = join(root, "manifest.json");
  writeFileSync(seedPath, JSON.stringify(document));
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      generated_at: "2026-01-01T00:00:00.000Z",
      entries,
    })
  );
  return { seedPath, manifestPath };
}
