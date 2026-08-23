CREATE TABLE `demo_studio_aliases` (
	`id` integer PRIMARY KEY NOT NULL,
	`studio_id` integer NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`studio_id`) REFERENCES `demo_studios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `demo_studio_aliases_studio_idx` ON `demo_studio_aliases` (`studio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `demo_studio_aliases_studio_name_unique` ON `demo_studio_aliases` (`studio_id`,`name`);--> statement-breakpoint
CREATE TABLE `demo_tag_aliases` (
	`id` integer PRIMARY KEY NOT NULL,
	`tag_id` integer NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `demo_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `demo_tag_aliases_tag_idx` ON `demo_tag_aliases` (`tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `demo_tag_aliases_tag_name_unique` ON `demo_tag_aliases` (`tag_id`,`name`);--> statement-breakpoint
CREATE TABLE `demo_tag_categories` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`group` text,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_tag_categories_name_unique` ON `demo_tag_categories` (`name`);--> statement-breakpoint
ALTER TABLE `demo_studios` ADD `parent_studio_id` integer REFERENCES demo_studios(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `demo_tags` ADD `category_id` integer REFERENCES demo_tag_categories(id) ON DELETE SET NULL;
