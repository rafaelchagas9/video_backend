CREATE TABLE "saved_library_views" (
	"user_id" integer NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	CONSTRAINT "saved_library_views_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "saved_library_views" ADD CONSTRAINT "saved_library_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;