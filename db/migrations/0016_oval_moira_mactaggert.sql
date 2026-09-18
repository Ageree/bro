CREATE TABLE "browser_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_profiles_profile_id_check" CHECK ("browser_profiles"."profile_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "browser_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"profile_id" text,
	"task" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"outcome" text,
	"live_view_url" text,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"reply_anchor_message_id" text,
	"root_session_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "browser_runs_status_check" CHECK ("browser_runs"."status" IN ('created', 'running', 'waiting', 'done', 'failed', 'stopped')),
	CONSTRAINT "browser_runs_conversation_channel_check" CHECK ("browser_runs"."conversation_channel" IN ('eve', 'photon', 'telegram')),
	CONSTRAINT "browser_runs_conversation_id_check" CHECK ("browser_runs"."conversation_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_runs_workspace_idx" ON "browser_runs" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "browser_runs_pending_idx" ON "browser_runs" USING btree ("status","updated_at");