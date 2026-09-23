CREATE TABLE "generated_image_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_pathname" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_image_artifacts_byte_size_check" CHECK ("generated_image_artifacts"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "usage_counters" DROP CONSTRAINT "usage_counters_kind_check";--> statement-breakpoint
ALTER TABLE "generated_image_artifacts" ADD CONSTRAINT "generated_image_artifacts_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generated_image_artifacts_workspace_idempotency_uidx" ON "generated_image_artifacts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "generated_image_artifacts_workspace_created_idx" ON "generated_image_artifacts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_kind_check" CHECK ("usage_counters"."kind" IN ('messages', 'browser_runs', 'image_generations', 'paywall_notices'));