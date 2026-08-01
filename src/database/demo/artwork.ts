import { readFileSync } from "fs";
import { resolve } from "path";
import { assertDemoAssetPath } from "./assets";
import { env } from "@/config/env";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "./client";

const VARIANT_CODES: Record<string, number> = {
  card: 1,
  poster: 2,
  square: 3,
  hero: 4,
  title: 5,
};

export type DemoArtworkCatalogEntry = {
  title: string;
  palette: unknown;
  assets: Record<string, any>;
};

type DemoArtworkRow = {
  video_id: number;
  title: string;
  status: string;
  palette_json: string | null;
  generated_at: string | null;
};

type DemoArtworkAssetRow = {
  id: number;
  video_id: number;
  variant: string;
  content_hash: string;
  file_path: string;
  file_size_bytes: number;
  width: number;
  height: number;
  source_timestamp_seconds: number | null;
  crop_json: string | null;
  focal_point_json: string | null;
  safe_area_json: string | null;
  bottom_luma: number | null;
  thumbhash: string | null;
  effects_json: string;
  generated_at: string;
};

export type DemoArtworkDatabaseSnapshot = {
  artwork: DemoArtworkRow[];
  assets: DemoArtworkAssetRow[];
};

export function captureDemoArtworkDatabaseSnapshot(): DemoArtworkDatabaseSnapshot {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  return {
    artwork: sqlite
      .query<DemoArtworkRow, []>("SELECT * FROM demo_artwork ORDER BY video_id")
      .all(),
    assets: sqlite
      .query<
        DemoArtworkAssetRow,
        []
      >("SELECT * FROM demo_artwork_assets ORDER BY id")
      .all(),
  };
}

export function restoreDemoArtworkDatabaseSnapshot(
  snapshot: DemoArtworkDatabaseSnapshot
): void {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  withDemoTransaction(() => {
    sqlite.exec("DELETE FROM demo_artwork_assets");
    sqlite.exec("DELETE FROM demo_artwork");
    const insertArtwork = sqlite.prepare(
      `INSERT INTO demo_artwork
       (video_id,title,status,palette_json,generated_at) VALUES (?,?,?,?,?)`
    );
    const insertAsset = sqlite.prepare(
      `INSERT INTO demo_artwork_assets (
        id,video_id,variant,content_hash,file_path,file_size_bytes,width,height,
        source_timestamp_seconds,crop_json,focal_point_json,safe_area_json,
        bottom_luma,thumbhash,effects_json,generated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const row of snapshot.artwork) {
      insertArtwork.run(
        row.video_id,
        row.title,
        row.status,
        row.palette_json,
        row.generated_at
      );
    }
    for (const row of snapshot.assets) {
      insertAsset.run(
        row.id,
        row.video_id,
        row.variant,
        row.content_hash,
        row.file_path,
        row.file_size_bytes,
        row.width,
        row.height,
        row.source_timestamp_seconds,
        row.crop_json,
        row.focal_point_json,
        row.safe_area_json,
        row.bottom_luma,
        row.thumbhash,
        row.effects_json,
        row.generated_at
      );
    }
  });
}

export function replaceDemoArtworkCatalog(
  entries: Record<string, DemoArtworkCatalogEntry>,
  generatedAt: string
): void {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  for (const [thumbnailPath, entry] of Object.entries(entries)) {
    assertDemoAssetPath(thumbnailPath, "artwork thumbnail key");
    for (const asset of Object.values(entry.assets)) {
      if (asset?.file_path) {
        assertDemoAssetPath(asset.file_path, `artwork ${asset.variant}`);
      }
    }
  }

  const videos = sqlite
    .query<{ id: number; title: string | null; thumbnail_path: string }, []>(
      `SELECT v.id, v.title, t.file_path AS thumbnail_path
       FROM demo_videos v
       JOIN demo_thumbnails t ON t.video_id = v.id`
    )
    .all();
  withDemoTransaction(() => {
    sqlite.exec("DELETE FROM demo_artwork_assets");
    sqlite.exec("DELETE FROM demo_artwork");
    const insertArtwork = sqlite.prepare(
      "INSERT INTO demo_artwork (video_id,title,status,palette_json,generated_at) VALUES (?,?,?,?,?)"
    );
    const insertAsset = sqlite.prepare(
      `INSERT INTO demo_artwork_assets (
        id,video_id,variant,content_hash,file_path,file_size_bytes,width,height,
        source_timestamp_seconds,crop_json,focal_point_json,safe_area_json,
        bottom_luma,thumbhash,effects_json,generated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const video of videos) {
      const entry = entries[video.thumbnail_path];
      if (!entry) continue;
      insertArtwork.run(
        video.id,
        entry.title,
        "ready",
        JSON.stringify(entry.palette),
        generatedAt
      );
      for (const asset of Object.values(entry.assets)) {
        if (!asset) continue;
        const code = VARIANT_CODES[asset.variant];
        if (!code)
          throw new Error(`Unknown demo artwork variant: ${asset.variant}`);
        insertAsset.run(
          video.id * 10 + code,
          video.id,
          asset.variant,
          asset.content_hash,
          asset.file_path,
          asset.file_size_bytes,
          asset.width,
          asset.height,
          asset.source_timestamp_seconds ?? null,
          asset.crop ? JSON.stringify(asset.crop) : null,
          asset.focal_point ? JSON.stringify(asset.focal_point) : null,
          asset.safe_area ? JSON.stringify(asset.safe_area) : null,
          asset.bottom_luma ?? null,
          asset.thumbhash ?? null,
          JSON.stringify(asset.effects || []),
          generatedAt
        );
      }
    }
  });
}

export function importDemoArtworkManifestFile(
  path = resolve(process.cwd(), env.DEMO_ASSETS_DIR, "artwork", "manifest.json")
): void {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    generated_at: string;
    entries: Record<string, DemoArtworkCatalogEntry>;
  };
  if (manifest.version !== 1) {
    throw new Error(
      `Unsupported demo artwork manifest version: ${manifest.version}`
    );
  }
  replaceDemoArtworkCatalog(manifest.entries, manifest.generated_at);
}

export function getDemoArtworkRecord(videoId: number):
  | (DemoArtworkCatalogEntry & {
      generated_at: string;
    })
  | null {
  initializeDemoDatabase();
  const sqlite = getDemoSqlite();
  const artwork = sqlite
    .query<
      {
        title: string;
        palette_json: string | null;
        generated_at: string;
      },
      [number]
    >(
      "SELECT title,palette_json,generated_at FROM demo_artwork WHERE video_id=?"
    )
    .get(videoId);
  if (!artwork) return null;
  const assets = Object.fromEntries(
    sqlite
      .query<any, [number]>(
        "SELECT * FROM demo_artwork_assets WHERE video_id=? ORDER BY id"
      )
      .all(videoId)
      .map((asset: any) => [
        asset.variant,
        {
          variant: asset.variant,
          content_hash: asset.content_hash,
          file_path: asset.file_path,
          file_size_bytes: Number(asset.file_size_bytes),
          width: Number(asset.width),
          height: Number(asset.height),
          source_timestamp_seconds: asset.source_timestamp_seconds,
          crop: asset.crop_json ? JSON.parse(asset.crop_json) : null,
          focal_point: asset.focal_point_json
            ? JSON.parse(asset.focal_point_json)
            : null,
          safe_area: asset.safe_area_json
            ? JSON.parse(asset.safe_area_json)
            : null,
          bottom_luma: asset.bottom_luma,
          thumbhash: asset.thumbhash,
          effects: JSON.parse(asset.effects_json),
        },
      ])
  );
  return {
    title: artwork.title,
    palette: artwork.palette_json ? JSON.parse(artwork.palette_json) : null,
    assets,
    generated_at: artwork.generated_at,
  };
}
