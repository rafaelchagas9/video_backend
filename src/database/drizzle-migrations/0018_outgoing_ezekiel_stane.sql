CREATE TABLE "multiplayer_remote_trusted_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"device_key_hash" text NOT NULL,
	"device_name" text,
	"device_type" text,
	"user_agent" text,
	"trusted_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "multiplayer_remote_join_requests" ADD COLUMN "remote_device_key_hash" text;--> statement-breakpoint
ALTER TABLE "multiplayer_remote_trusted_devices" ADD CONSTRAINT "multiplayer_remote_trusted_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_trusted_devices_owner_user" ON "multiplayer_remote_trusted_devices" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_trusted_devices_device_key_hash" ON "multiplayer_remote_trusted_devices" USING btree ("device_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "multiplayer_remote_trusted_devices_owner_device_unique" ON "multiplayer_remote_trusted_devices" USING btree ("owner_user_id","device_key_hash");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_join_requests_remote_device_key_hash" ON "multiplayer_remote_join_requests" USING btree ("remote_device_key_hash");