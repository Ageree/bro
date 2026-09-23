CREATE TABLE "gmail_attachment_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_part_id" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_pathname" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_attachment_artifacts_byte_size_check" CHECK ("gmail_attachment_artifacts"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "gmail_attachment_artifacts" ADD CONSTRAINT "gmail_attachment_artifacts_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_attachment_artifacts_session_part_uidx" ON "gmail_attachment_artifacts" USING btree ("workspace_id","root_session_id","gmail_message_id","gmail_part_id");--> statement-breakpoint
CREATE INDEX "gmail_attachment_artifacts_workspace_created_idx" ON "gmail_attachment_artifacts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);