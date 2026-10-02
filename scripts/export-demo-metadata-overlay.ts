/** Explicit opt-in export: PostgreSQL is read-only; only metadata reaches demo assets. */
import postgres from "postgres";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../src/config/env";

if (!process.argv.includes("--read-only-export"))
  throw new Error(
    "Use --read-only-export to explicitly copy library metadata into the demo"
  );
const demoRoot = resolve(process.cwd(), env.DEMO_ASSETS_DIR);
const sql = postgres({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  database: env.POSTGRES_DB,
  username: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  max: 1,
});
try {
  const data = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [mode] = await tx`SHOW transaction_read_only`;
      if (mode?.transaction_read_only !== "on")
        throw new Error("Source transaction must be read-only");
      const creators = await tx`
      SELECT c.id AS source_id, c.name, c.description,
        jsonb_build_object('gender',c.gender,'birth_date',c.birth_date,'death_date',c.death_date,
          'ethnicity',c.ethnicity,'country',c.country,'birthplace',c.birthplace,
          'eye_color',c.eye_color,'hair_color',c.hair_color,'height_cm',c.height_cm,
          'cup_size',c.cup_size,'band_size',c.band_size,'waist_size',c.waist_size,
          'hip_size',c.hip_size,'breast_type',c.breast_type,
          'career_start_year',c.career_start_year,'career_end_year',c.career_end_year,
          'external_ids',COALESCE((SELECT jsonb_agg(jsonb_build_object('source',e.source,'external_id',e.external_id,'url',e.external_url,'last_synced_at',e.last_synced_at)) FROM creator_external_ids e WHERE e.creator_id=c.id),'[]'::jsonb)) AS facts,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.name,'note',a.note)) FROM creator_aliases a WHERE a.creator_id=c.id),'[]'::jsonb) AS aliases,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('platform_name',p.name,'username',cp.username,'profile_url',cp.profile_url,'is_primary',cp.is_primary)) FROM creator_platforms cp JOIN platforms p ON p.id=cp.platform_id WHERE cp.creator_id=c.id),'[]'::jsonb) AS platforms,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('platform_name',s.platform_name,'url',s.url)) FROM creator_social_links s WHERE s.creator_id=c.id),'[]'::jsonb) AS socials
      FROM creators c
      WHERE EXISTS (SELECT 1 FROM creator_external_ids e WHERE e.creator_id=c.id)
        AND EXISTS (SELECT 1 FROM video_creators vc WHERE vc.creator_id=c.id)
      ORDER BY (SELECT count(*) FROM creator_external_ids e WHERE e.creator_id=c.id) DESC,
        (CASE WHEN c.description IS NULL THEN 0 ELSE 1 END) DESC,
        (SELECT count(*) FROM creator_aliases a WHERE a.creator_id=c.id) DESC, c.id
      LIMIT 8`;
      const videos = [];
      for (const creator of creators) {
        const selected = await tx`
        SELECT v.id AS source_id, ${creator.source_id}::int AS source_creator_id,
          v.title,v.description,v.created_at,
          COALESCE((SELECT jsonb_agg(t.name) FROM video_tags vt JOIN tags t ON t.id=vt.tag_id WHERE vt.video_id=v.id),'[]'::jsonb) AS tags,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('name',s.name,'description',s.description)) FROM video_studios vs JOIN studios s ON s.id=vs.studio_id WHERE vs.video_id=v.id),'[]'::jsonb) AS studios
        FROM videos v JOIN video_creators vc ON vc.video_id=v.id
        WHERE vc.creator_id=${creator.source_id}
        ORDER BY (SELECT count(*) FROM video_tags vt WHERE vt.video_id=v.id) DESC,v.id LIMIT 2`;
        videos.push(...selected);
      }
      return { creators, videos, source_transaction_read_only: true };
    }
  );
  const overlay = {
    version: 1,
    generated_at: new Date().toISOString(),
    note: "Real metadata only. Images are fictional SFW artwork; video streams reuse seeded demo clips. No library files, credentials or original image paths copied.",
    artwork: [
      "demo_mode/sfw/portfolio-studio.png",
      "demo_mode/sfw/portfolio-gallery.png",
    ],
    ...data,
  };
  await mkdir(demoRoot, { recursive: true });
  await writeFile(
    resolve(demoRoot, "metadata-overlay.json"),
    JSON.stringify(overlay, null, 2),
    { mode: 0o600 }
  );
  console.log(
    JSON.stringify({
      creators: data.creators.length,
      videos: data.videos.length,
      source_transaction_read_only: true,
      media_files_copied: 0,
      output: "demo_mode/metadata-overlay.json",
    })
  );
} finally {
  await sql.end();
}
