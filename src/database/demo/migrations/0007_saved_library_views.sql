CREATE TABLE `demo_saved_library_views` (
	`user_id` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
