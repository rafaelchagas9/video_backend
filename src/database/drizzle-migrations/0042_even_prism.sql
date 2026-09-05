ALTER TABLE "bookmarks" DROP CONSTRAINT "bookmarks_analysis_run_id_content_analysis_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_analysis_run_id_content_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."content_analysis_runs"("id") ON DELETE cascade ON UPDATE no action;