CREATE TABLE "multiplayer_remote_join_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"requesting_user_id" integer NOT NULL,
	"requesting_session_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_code" text NOT NULL,
	"remote_device_name" text,
	"remote_device_type" text,
	"remote_user_agent" text,
	"expires_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "multiplayer_remote_join_requests_status_check" CHECK ("multiplayer_remote_join_requests"."status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "multiplayer_remote_join_requests_requested_code_format_check" CHECK ("multiplayer_remote_join_requests"."requested_code" ~ '^[A-Z0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "multiplayer_remote_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"display_client_id" text,
	"remote_client_id" text,
	"pairing_code" text,
	"pairing_code_expires_at" timestamp,
	"status" text DEFAULT 'waiting_for_remote' NOT NULL,
	"display_connected_at" timestamp,
	"display_last_seen_at" timestamp,
	"remote_connected_at" timestamp,
	"remote_last_seen_at" timestamp,
	"approved_at" timestamp,
	"closed_at" timestamp,
	"close_reason" text,
	"last_state_json" json,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "multiplayer_remote_sessions_status_check" CHECK ("multiplayer_remote_sessions"."status" IN ('waiting_for_remote', 'pending_approval', 'active', 'closed', 'expired')),
	CONSTRAINT "multiplayer_remote_sessions_pairing_code_format_check" CHECK ("multiplayer_remote_sessions"."pairing_code" IS NULL OR "multiplayer_remote_sessions"."pairing_code" ~ '^[A-Z0-9]{6}$'),
	CONSTRAINT "multiplayer_remote_sessions_protocol_version_check" CHECK ("multiplayer_remote_sessions"."protocol_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "multiplayer_remote_join_requests" ADD CONSTRAINT "multiplayer_remote_join_requests_session_id_multiplayer_remote_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."multiplayer_remote_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multiplayer_remote_join_requests" ADD CONSTRAINT "multiplayer_remote_join_requests_requesting_user_id_users_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multiplayer_remote_join_requests" ADD CONSTRAINT "multiplayer_remote_join_requests_requesting_session_id_sessions_id_fk" FOREIGN KEY ("requesting_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multiplayer_remote_sessions" ADD CONSTRAINT "multiplayer_remote_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_join_requests_session" ON "multiplayer_remote_join_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_join_requests_requesting_user" ON "multiplayer_remote_join_requests" USING btree ("requesting_user_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_join_requests_requesting_session" ON "multiplayer_remote_join_requests" USING btree ("requesting_session_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_join_requests_status" ON "multiplayer_remote_join_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "multiplayer_remote_join_requests_pending_session_unique" ON "multiplayer_remote_join_requests" USING btree ("session_id") WHERE "multiplayer_remote_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_sessions_owner_user" ON "multiplayer_remote_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_sessions_status" ON "multiplayer_remote_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_sessions_display_client" ON "multiplayer_remote_sessions" USING btree ("display_client_id");--> statement-breakpoint
CREATE INDEX "idx_multiplayer_remote_sessions_remote_client" ON "multiplayer_remote_sessions" USING btree ("remote_client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "multiplayer_remote_sessions_pairing_code_unique" ON "multiplayer_remote_sessions" USING btree ("pairing_code") WHERE "multiplayer_remote_sessions"."pairing_code" IS NOT NULL;