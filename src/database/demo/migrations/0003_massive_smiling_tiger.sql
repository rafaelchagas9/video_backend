ALTER TABLE `demo_collections` ADD `artwork_source_video_id` integer REFERENCES demo_videos(id);--> statement-breakpoint
ALTER TABLE `demo_playlists` ADD `artwork_source_video_id` integer REFERENCES demo_videos(id);--> statement-breakpoint
UPDATE `demo_playlists`
SET `artwork_source_video_id` = (
	SELECT pv.`video_id`
	FROM `demo_playlist_videos` pv
	WHERE pv.`playlist_id` = `demo_playlists`.`id`
	ORDER BY pv.`position`, pv.`added_at`
	LIMIT 1
);--> statement-breakpoint
UPDATE `demo_collections`
SET `artwork_source_video_id` = (
	SELECT e.`video_id`
	FROM `demo_collection_entries` e
	WHERE e.`collection_id` = `demo_collections`.`id`
	ORDER BY
		CASE WHEN e.`sequence_number` IS NULL THEN 1 ELSE 0 END,
		e.`sequence_number`,
		e.`season_number`,
		e.`episode_number`,
		e.`episode_part`,
		e.`absolute_number`,
		e.`created_at`
	LIMIT 1
);
