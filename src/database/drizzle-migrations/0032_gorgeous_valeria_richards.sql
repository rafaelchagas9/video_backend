ALTER TABLE "playlists" ADD COLUMN "artwork_source_video_id" integer;--> statement-breakpoint
ALTER TABLE "video_collections" ADD COLUMN "artwork_source_video_id" integer;--> statement-breakpoint
UPDATE "playlists" p
SET "artwork_source_video_id" = (
	SELECT pv."video_id"
	FROM "playlist_videos" pv
	INNER JOIN "videos" v ON v."id" = pv."video_id"
	WHERE pv."playlist_id" = p."id"
	ORDER BY pv."position", pv."added_at"
	LIMIT 1
);--> statement-breakpoint
UPDATE "video_collections" c
SET "artwork_source_video_id" = (
	SELECT e."video_id"
	FROM "video_collection_entries" e
	INNER JOIN "videos" v ON v."id" = e."video_id"
	WHERE e."collection_id" = c."id"
	ORDER BY
		CASE WHEN e."sequence_number" IS NULL THEN 1 ELSE 0 END,
		e."sequence_number",
		e."season_number",
		e."episode_number",
		e."episode_part",
		e."absolute_number",
		e."created_at"
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_artwork_source_video_id_videos_id_fk" FOREIGN KEY ("artwork_source_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_collections" ADD CONSTRAINT "video_collections_artwork_source_video_id_videos_id_fk" FOREIGN KEY ("artwork_source_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_playlists_artwork_source" ON "playlists" USING btree ("artwork_source_video_id");--> statement-breakpoint
CREATE INDEX "idx_video_collections_artwork_source" ON "video_collections" USING btree ("artwork_source_video_id");
