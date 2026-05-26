CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_sessions_user";--> statement-breakpoint
DROP INDEX "idx_sessions_expires";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
UPDATE "users"
SET
	"name" = COALESCE(NULLIF("username", ''), 'User ' || "id"::text),
	"email" = CASE
		WHEN "username" ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN lower("username")
		WHEN "username" IS NOT NULL AND "username" <> '' THEN lower(regexp_replace("username", '[^a-zA-Z0-9._%+-]+', '-', 'g')) || '-' || "id"::text || '@local.invalid'
		ELSE 'user-' || "id"::text || '@local.invalid'
	END,
	"email_verified" = true
WHERE "name" IS NULL OR "email" IS NULL OR "email_verified" = false;--> statement-breakpoint
UPDATE "sessions"
SET "token" = "id"
WHERE "token" IS NULL;--> statement-breakpoint
INSERT INTO "accounts" (
	"id",
	"account_id",
	"provider_id",
	"user_id",
	"password",
	"created_at",
	"updated_at"
)
SELECT
	"users"."id"::text || '-credential',
	"users"."id"::text,
	'credential',
	"users"."id",
	"users"."password_hash",
	"users"."created_at",
	"users"."updated_at"
FROM "users"
WHERE "users"."password_hash" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "accounts"
		WHERE "accounts"."user_id" = "users"."id"
			AND "accounts"."provider_id" = 'credential'
	);--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_provider_id_idx" ON "accounts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");
