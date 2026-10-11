-- Comparison identity is its position in the finite round, not its reusable left clip.
-- Create both replacements before dropping the old index. A duplicate versus position
-- fails before the original uniqueness can be removed; the migrator applies this atomically.
CREATE UNIQUE INDEX "recording_label_tasks_versus_position" ON "recording_label_tasks" USING btree ("kind","batch","position") WHERE "kind" = 'versus';
--> statement-breakpoint
CREATE UNIQUE INDEX "recording_label_tasks_nonversus_item" ON "recording_label_tasks" USING btree ("kind","batch","video_id","start_seconds") WHERE "kind" <> 'versus';
--> statement-breakpoint
DROP INDEX "recording_label_tasks_item";
