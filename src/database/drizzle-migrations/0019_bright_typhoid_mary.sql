CREATE TABLE "multiplayer_remote_display_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"public_id" text NOT NULL,
	"auth_token_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"device_type" text,
	"trusted_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"last_heartbeat_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "multiplayer_remote_sessions" ADD COLUMN "display_device_id" integer;--> statement-breakpoint
ALTER TABLE "multiplayer_remote_display_devices" ADD CONSTRAINT "multiplayer_remote_display_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_display_devices_owner_user" ON "multiplayer_remote_display_devices" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "multiplayer_remote_display_devices_public_id_unique" ON "multiplayer_remote_display_devices" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "multiplayer_remote_display_devices_auth_token_hash_unique" ON "multiplayer_remote_display_devices" USING btree ("auth_token_hash");--> statement-breakpoint
ALTER TABLE "multiplayer_remote_sessions" ADD CONSTRAINT "multiplayer_remote_sessions_display_device_id_multiplayer_remote_display_devices_id_fk" FOREIGN KEY ("display_device_id") REFERENCES "public"."multiplayer_remote_display_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_sessions_display_device" ON "multiplayer_remote_sessions" USING btree ("display_device_id");