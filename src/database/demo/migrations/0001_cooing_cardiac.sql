CREATE TABLE `demo_creator_studios` (
	`creator_id` integer NOT NULL,
	`studio_id` integer NOT NULL,
	PRIMARY KEY(`creator_id`, `studio_id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studio_id`) REFERENCES `demo_studios`(`id`) ON UPDATE no action ON DELETE cascade
);
