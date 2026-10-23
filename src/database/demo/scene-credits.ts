/**
 * Enriched-scene stand-ins for demo mode (`demo_mode/scene-credits.json`).
 *
 * The demo catalogue had no source metadata at all, so the scene credits, the
 * cover-as-artwork upgrade and the cover comparison in the review had nothing
 * to render. The fixture gives a handful of trailers the shapes real enriched
 * scenes have — huge casts, tag-heavy scenes, long synopses, tall posters,
 * covers smaller than the frame — and is re-applied after every baseline reset.
 *
 * Cover-cut artwork comes from `scripts/demo-render-cover-artwork.ts`, which
 * runs the real artwork pipeline and writes `scene-credits-artwork.json`
 * (re-applied on each start, like the rest of the fixture).
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { z } from "zod";
import { env } from "@/config/env";
import { getDemoSqlite, withDemoTransaction } from "./client";
import { resolveDemoAssetPath } from "./assets";

const sceneSchema = z.object({
  video_id: z.number().int(),
  title: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  external_ids: z
    .array(z.object({ source: z.string(), external_id: z.string(), url: z.string().nullable().optional() }))
    .default([]),
  creator_ids: z.array(z.number().int()).optional(),
  tag_ids: z.array(z.number().int()).optional(),
  cover: z.string().optional(),
  candidates: z.array(z.string()).default([]),
});
export type DemoScene = z.infer<typeof sceneSchema>;

const artworkSchema = z.record(
  z.string(),
  z.object({
    palette: z.unknown(),
    assets: z.array(
      z.object({
        variant: z.string(),
        content_hash: z.string(),
        file_path: z.string(),
        file_size_bytes: z.number(),
        width: z.number(),
        height: z.number(),
        source_timestamp_seconds: z.number().nullable(),
        crop: z.unknown(),
        focal_point: z.unknown(),
        safe_area: z.unknown(),
        bottom_luma: z.number().nullable(),
        effects: z.array(z.string()),
      })
    ),
  })
);

const TIMESTAMP = "2026-10-22T00:00:00.000Z";
let cached: DemoScene[] | null = null;

function fixturePath(name: string): string {
  return join(process.cwd(), env.DEMO_ASSETS_DIR, name);
}

export function demoSceneFixture(): DemoScene[] {
  if (cached) return cached;
  const path = fixturePath("scene-credits.json");
  cached = existsSync(path)
    ? z.object({ scenes: z.array(sceneSchema) }).parse(JSON.parse(readFileSync(path, "utf8"))).scenes
    : [];
  return cached;
}

function demoSceneArtwork() {
  const path = fixturePath("scene-credits-artwork.json");
  return existsSync(path) ? artworkSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : {};
}

export async function ensureDemoSceneCredits(): Promise<number> {
  const scenes = demoSceneFixture();
  if (scenes.length === 0) return 0;
  const artwork = demoSceneArtwork();
  const db = getDemoSqlite();
  const exists = (id: number) =>
    db.query<{ id: number }, [number]>("SELECT id FROM demo_videos WHERE id=?").get(id);
  const put = (kind: string, id: string, payload: unknown) =>
    db.run(
      "INSERT INTO demo_resources (kind,id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at",
      [kind, id, JSON.stringify(payload), TIMESTAMP, TIMESTAMP]
    );

  // Cover sizes are read up front; sharp is async and the transaction is not.
  const covers = new Map<number, { width: number; height: number; size: number }>();
  for (const scene of scenes) {
    if (!scene.cover) continue;
    const path = resolveDemoAssetPath(scene.cover);
    const meta = await sharp(path).metadata();
    covers.set(scene.video_id, { width: meta.width ?? 0, height: meta.height ?? 0, size: statSync(path).size });
  }

  let applied = 0;
  withDemoTransaction(() => {
    for (const scene of scenes) {
      if (!exists(scene.video_id)) continue;
      applied += 1;
      const id = scene.video_id;
      if (scene.title !== undefined || scene.description !== undefined) {
        db.run(
          "UPDATE demo_videos SET title=COALESCE(?,title), description=COALESCE(?,description) WHERE id=?",
          [scene.title ?? null, scene.description ?? null, id]
        );
      }
      for (const [key, value] of Object.entries(scene.metadata)) {
        put("video-metadata", `${id}:${key}`, { video_id: id, key, value, created_at: TIMESTAMP, updated_at: TIMESTAMP });
      }
      for (const entry of scene.external_ids) {
        put("video-external-id", `${id}:${entry.source}`, {
          source: entry.source,
          external_id: entry.external_id,
          url: entry.url ?? null,
          last_synced_at: TIMESTAMP,
        });
      }
      if (scene.creator_ids) {
        db.run("DELETE FROM demo_video_creators WHERE video_id=?", [id]);
        for (const creator of scene.creator_ids)
          db.run("INSERT OR IGNORE INTO demo_video_creators (video_id,creator_id) SELECT ?, id FROM demo_creators WHERE id=?", [id, creator]);
      }
      if (scene.tag_ids) {
        db.run("DELETE FROM demo_video_tags WHERE video_id=?", [id]);
        for (const tag of scene.tag_ids)
          db.run("INSERT OR IGNORE INTO demo_video_tags (video_id,tag_id) SELECT ?, id FROM demo_tags WHERE id=?", [id, tag]);
      }
      const cover = covers.get(id);
      if (scene.cover && cover) {
        const name = scene.cover.split("/").pop()!;
        const url = `/api/videos/${id}/cover/image?file=${encodeURIComponent(name)}`;
        put("video-metadata", `${id}:cover_image_url`, { video_id: id, key: "cover_image_url", value: url, created_at: TIMESTAMP, updated_at: TIMESTAMP });
        put("video-cover", String(id), {
          file: scene.cover,
          source_url: url,
          width: cover.width,
          height: cover.height,
          file_size_bytes: cover.size,
          fetched_at: TIMESTAMP,
        });
      }
      const art = artwork[String(id)];
      if (art) {
        db.run("UPDATE demo_artwork SET palette_json=? WHERE video_id=?", [JSON.stringify(art.palette), id]);
        for (const asset of art.assets) {
          db.run(
            `UPDATE demo_artwork_assets SET content_hash=?, file_path=?, file_size_bytes=?, width=?, height=?,
               source_timestamp_seconds=?, crop_json=?, focal_point_json=?, safe_area_json=?, bottom_luma=?, effects_json=?
             WHERE video_id=? AND variant=?`,
            [
              asset.content_hash, asset.file_path, asset.file_size_bytes, asset.width, asset.height,
              asset.source_timestamp_seconds, JSON.stringify(asset.crop), JSON.stringify(asset.focal_point),
              JSON.stringify(asset.safe_area), asset.bottom_luma, JSON.stringify(asset.effects), id, asset.variant,
            ]
          );
        }
      }
    }
  });
  return applied;
}
