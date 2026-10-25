CREATE TABLE "browser_download_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"browser_run_id" text NOT NULL,
	"path" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_pathname" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_download_artifacts_byte_size_check" CHECK ("browser_download_artifacts"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "browser_download_artifacts" ADD CONSTRAINT "browser_download_artifacts_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_download_artifacts_run_path_uidx" ON "browser_download_artifacts" USING btree ("browser_run_id","path");--> statement-breakpoint
CREATE INDEX "browser_download_artifacts_workspace_created_idx" ON "browser_download_artifacts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);