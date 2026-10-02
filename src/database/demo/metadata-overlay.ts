/** Optional, local, metadata-only fixture applied after demo baseline restoration. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { env } from "@/config/env";
import { getDemoSqlite } from "./client";
import { resolveDemoAssetPath } from "./assets";

const creator = z.object({
  source_id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  facts: z.record(z.string(), z.unknown()),
  aliases: z.array(z.object({ name: z.string(), note: z.string().nullable() })),
  platforms: z.array(
    z.object({
      platform_name: z.string(),
      username: z.string(),
      profile_url: z.httpUrl(),
      is_primary: z.boolean(),
    })
  ),
  socials: z.array(z.object({ platform_name: z.string(), url: z.httpUrl() })),
});
const overlaySchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  artwork: z.array(z.string()).min(1),
  source_transaction_read_only: z.literal(true),
  creators: z.array(creator),
  videos: z.array(
    z.object({
      source_id: z.number().int(),
      source_creator_id: z.number().int(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      created_at: z.string(),
      tags: z.array(z.string()),
      studios: z.array(
        z.object({ name: z.string(), description: z.string().nullable() })
      ),
    })
  ),
});

export function applyDemoMetadataOverlay(
  options: { allowInTests?: boolean } = {}
): {
  creators: number;
  videos: number;
} | null {
  if (
    !options.allowInTests &&
    (env.NODE_ENV === "test" || process.env.NODE_ENV === "test")
  )
    return null;
  const path = join(
    process.cwd(),
    env.DEMO_ASSETS_DIR,
    "metadata-overlay.json"
  );
  if (!existsSync(path)) return null;
  const overlay = overlaySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const pictures = overlay.artwork.map((p) => resolveDemoAssetPath(p));
  const db = getDemoSqlite();
  const stamp = overlay.generated_at;
  const insert = (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    db.run(
      `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      Object.values(row) as any[]
    );
  };
  const find = (table: string, name: string): { id: number } | null =>
    db
      .query<{ id: number }, [string]>(`SELECT id FROM ${table} WHERE name=?`)
      .get(name);
  const next = (table: string): number =>
    db
      .query<{ id: number }, []>(
        `SELECT COALESCE(MAX(id),0)+1 AS id FROM ${table}`
      )
      .get()?.id ?? 1;
  const transaction = db.transaction(() => {
    const template = db
      .query<Record<string, any>, []>(
        "SELECT * FROM demo_videos WHERE is_available=1 ORDER BY id LIMIT 1"
      )
      .get();
    if (!template)
      throw new Error("Seed a safe demo clip before applying metadata overlay");
    resolveDemoAssetPath(template.file_path);
    const ids = new Map<number, number>();
    overlay.creators.forEach((c, index) => {
      const id = find("demo_creators", c.name)?.id ?? next("demo_creators");
      ids.set(c.source_id, id);
      const artwork = pictures[index % pictures.length];
      insert("demo_creators", {
        id,
        name: c.name,
        description: c.description,
        profile_picture_path: artwork,
        main_picture_path: artwork,
        face_thumbnail_path: artwork,
        extra_json: JSON.stringify(c.facts),
        created_at: stamp,
        updated_at: stamp,
      });
      db.run(
        "UPDATE demo_creators SET description=?,profile_picture_path=?,main_picture_path=?,face_thumbnail_path=?,extra_json=?,updated_at=? WHERE id=?",
        [
          c.description,
          artwork,
          artwork,
          artwork,
          JSON.stringify({ ...c.facts, demo_artwork_fictional: true }),
          stamp,
          id,
        ]
      );
      for (const a of c.aliases)
        if (
          !db
            .query(
              "SELECT 1 FROM demo_creator_aliases WHERE creator_id=? AND name=?"
            )
            .get(id, a.name)
        )
          insert("demo_creator_aliases", {
            id: next("demo_creator_aliases"),
            creator_id: id,
            name: a.name,
            note: a.note,
            created_at: stamp,
          });
      for (const p of c.platforms)
        if (
          !db
            .query(
              "SELECT 1 FROM demo_creator_platforms WHERE creator_id=? AND platform_name=?"
            )
            .get(id, p.platform_name)
        )
          insert("demo_creator_platforms", {
            id: next("demo_creator_platforms"),
            creator_id: id,
            platform_id: next("demo_creator_platforms"),
            platform_name: p.platform_name,
            username: p.username,
            profile_url: p.profile_url,
            is_primary: Number(p.is_primary),
            created_at: stamp,
            updated_at: stamp,
          });
      for (const s of c.socials)
        if (
          !db
            .query(
              "SELECT 1 FROM demo_creator_social_links WHERE creator_id=? AND url=?"
            )
            .get(id, s.url)
        )
          insert("demo_creator_social_links", {
            id: next("demo_creator_social_links"),
            creator_id: id,
            ...s,
            created_at: stamp,
          });
      db.run(
        "UPDATE demo_creator_gallery SET file_path=?,description=? WHERE creator_id=?",
        [
          artwork,
          "Fictional SFW portfolio artwork for the demo; not a photo of this creator.",
          id,
        ]
      );
      for (let gallery = 0; gallery < pictures.length; gallery++)
        insert("demo_creator_gallery", {
          id: 2100000 + index * 10 + gallery,
          creator_id: id,
          label:
            gallery === 0
              ? "Studio portfolio (SFW illustration)"
              : "Gallery portfolio (SFW illustration)",
          description:
            "Fictional SFW artwork; real metadata, no real portrait.",
          file_path: pictures[gallery],
          is_profile_picture: Number(gallery === 0),
          is_main_picture: Number(gallery === 0),
          created_at: stamp,
          updated_at: stamp,
        });
    });
    const imported = new Map<number, number>();
    overlay.videos.forEach((v, index) => {
      const id = imported.get(v.source_id) ?? 2200000 + index;
      imported.set(v.source_id, id);
      const creatorId = ids.get(v.source_creator_id)!;
      insert("demo_videos", {
        ...template,
        id,
        source_video_id: v.source_id,
        title: v.title,
        description: v.description,
        created_at: v.created_at,
        updated_at: stamp,
      });
      insert("demo_video_creators", { video_id: id, creator_id: creatorId });
      const picture = pictures[index % pictures.length];
      const thumbnail = db
        .query<Record<string, any>, [number]>(
          "SELECT * FROM demo_thumbnails WHERE video_id=?"
        )
        .get(template.id);
      if (thumbnail) {
        const png = readFileSync(picture);
        insert("demo_thumbnails", {
          ...thumbnail,
          video_id: id,
          file_path: picture,
          file_size_bytes: statSync(picture).size,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        });
      }
      for (const tag of v.tags) {
        const tagId = find("demo_tags", tag)?.id ?? next("demo_tags");
        insert("demo_tags", {
          id: tagId,
          name: tag,
          parent_id: null,
          category_id: null,
          description: null,
          color: "#64748b",
          created_at: stamp,
          updated_at: stamp,
        });
        insert("demo_video_tags", { video_id: id, tag_id: tagId });
      }
      for (const s of v.studios) {
        const studioId =
          find("demo_studios", s.name)?.id ?? next("demo_studios");
        insert("demo_studios", {
          id: studioId,
          name: s.name,
          description: s.description,
          profile_picture_path: null,
          parent_studio_id: null,
          created_at: stamp,
          updated_at: stamp,
        });
        insert("demo_video_studios", { video_id: id, studio_id: studioId });
        insert("demo_creator_studios", {
          creator_id: creatorId,
          studio_id: studioId,
        });
      }
    });
    // Optional representative collection. Never replace an existing document,
    // including an intentionally empty document saved by the user.
    for (const creatorId of ids.values()) {
      const galleryIds = db
        .query<{ id: number }, [number]>(
          "SELECT id FROM demo_creator_gallery WHERE creator_id=? AND id>=2100000 AND id<2200000 ORDER BY id LIMIT 2"
        )
        .all(creatorId)
        .map((row) => row.id);
      const videoIds = db
        .query<{ id: number }, [number]>(
          "SELECT video_id AS id FROM demo_video_creators WHERE creator_id=? AND video_id>=2200000 ORDER BY video_id LIMIT 2"
        )
        .all(creatorId)
        .map((row) => row.id);
      if (galleryIds.length < 2 || videoIds.length < 2) continue;
      const key = `creator_collection_sets:${creatorId}`;
      const document = {
        revision: 1,
        sets: [
          {
            id: "79123348-7469-4d14-91e4-97a731ac0045",
            title: "Portfolio demo · SFW",
            description:
              "Duas ilustrações fictícias SFW e dois clipes de demonstração, com metadados autorizados da biblioteca.",
            release_date: null,
            source_url: null,
            gallery_ids: galleryIds,
            video_ids: videoIds,
            removed_gallery_ids: [],
            removed_video_ids: [],
            created_at: stamp,
            updated_at: stamp,
          },
        ],
      };
      db.run(
        "INSERT OR IGNORE INTO demo_settings(key,value_json,updated_at) VALUES(?,?,?)",
        [key, JSON.stringify(JSON.stringify(document)), stamp]
      );
      break;
    }
    db.run(
      "INSERT OR REPLACE INTO demo_meta(key,value,updated_at) VALUES ('metadata_overlay',?,?)",
      [
        JSON.stringify({
          creators: overlay.creators.length,
          videos: imported.size,
          source_read_only: true,
          artwork_fictional: true,
        }),
        stamp,
      ]
    );
    return { creators: overlay.creators.length, videos: imported.size };
  });
  return transaction();
}
