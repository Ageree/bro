CREATE TABLE "drive_file_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"drive_file_id" text NOT NULL,
	"drive_version" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_pathname" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_file_artifacts_byte_size_check" CHECK ("drive_file_artifacts"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "drive_file_artifacts" ADD CONSTRAINT "drive_file_artifacts_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_file_artifacts_session_file_uidx" ON "drive_file_artifacts" USING btree ("workspace_id","root_session_id","drive_file_id","drive_version");--> statement-breakpoint
CREATE INDEX "drive_file_artifacts_workspace_created_idx" ON "drive_file_artifacts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);