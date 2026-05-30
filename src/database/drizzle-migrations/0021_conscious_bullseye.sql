CREATE TABLE "creator_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_creator_alias" UNIQUE("creator_id","name")
);
--> statement-breakpoint
ALTER TABLE "creator_aliases" ADD CONSTRAINT "creator_aliases_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_aliases_creator" ON "creator_aliases" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_creator_aliases_name" ON "creator_aliases" USING btree ("name");