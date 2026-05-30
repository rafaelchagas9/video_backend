CREATE TABLE "creator_favorites" (
	"user_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creator_favorites_user_id_creator_id_pk" PRIMARY KEY("user_id","creator_id")
);
--> statement-breakpoint
ALTER TABLE "creator_favorites" ADD CONSTRAINT "creator_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_favorites" ADD CONSTRAINT "creator_favorites_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_favorites_user" ON "creator_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_creator_favorites_creator" ON "creator_favorites" USING btree ("creator_id");