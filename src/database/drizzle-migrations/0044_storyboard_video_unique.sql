-- Legacy PostgreSQL installations lack the uniqueness declared by the ORM.
-- Preserve superseded metadata in an archive; do not remove any media files.
LOCK TABLE "storyboards" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS maintenance;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS maintenance.storyboard_duplicates_0044 (
  original_id integer PRIMARY KEY,
  retained_id integer NOT NULL,
  row_data jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY video_id ORDER BY generated_at DESC NULLS LAST, id DESC
    ) AS retained_id,
    row_number() OVER (
      PARTITION BY video_id ORDER BY generated_at DESC NULLS LAST, id DESC
    ) AS position
  FROM storyboards
), archived AS (
  INSERT INTO maintenance.storyboard_duplicates_0044 (original_id, retained_id, row_data)
  SELECT s.id, ranked.retained_id, to_jsonb(s)
  FROM storyboards s JOIN ranked ON ranked.id = s.id
  WHERE ranked.position > 1
  RETURNING original_id
)
DELETE FROM storyboards USING archived WHERE storyboards.id = archived.original_id;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'storyboards'::regclass AND conname = 'storyboards_video_id_unique'
  ) THEN
    ALTER TABLE storyboards ADD CONSTRAINT storyboards_video_id_unique UNIQUE (video_id);
  END IF;
END $$;
