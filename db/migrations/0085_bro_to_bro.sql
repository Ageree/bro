CREATE TABLE "bro_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"inviter_workspace_id" text NOT NULL,
	"inviter_user_id" text NOT NULL,
	"label" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"opened_by_workspace_id" text,
	"opened_at" timestamp (3) with time zone,
	"redeemed_at" timestamp (3) with time zone,
	"redeemed_by_workspace_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bro_invites_label_check" CHECK (char_length("bro_invites"."label") <= 200)
);
--> statement-breakpoint
CREATE TABLE "bro_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"peer_workspace_id" text NOT NULL,
	"peer_user_id" text NOT NULL,
	"invite_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"calendar" boolean DEFAULT true NOT NULL,
	"share_notes" text,
	"peer_label" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp (3) with time zone,
	CONSTRAINT "bro_links_status_check" CHECK ("bro_links"."status" IN ('pending', 'active')),
	CONSTRAINT "bro_links_pair_check" CHECK ("bro_links"."workspace_id" <> "bro_links"."peer_workspace_id"),
	CONSTRAINT "bro_links_share_notes_check" CHECK (char_length("bro_links"."share_notes") <= 2000),
	CONSTRAINT "bro_links_peer_label_check" CHECK (char_length("bro_links"."peer_label") <= 200)
);
--> statement-breakpoint
CREATE TABLE "bro_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" text NOT NULL,
	"action" text NOT NULL,
	"body" text NOT NULL,
	"proposal" jsonb,
	"accepts_message_id" uuid,
	"approved_by_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bro_messages_side_check" CHECK ("bro_messages"."side" IN ('initiator', 'responder')),
	CONSTRAINT "bro_messages_action_check" CHECK ("bro_messages"."action" IN ('message', 'propose', 'accept', 'decline', 'ask_owner', 'close')),
	CONSTRAINT "bro_messages_proposal_check" CHECK (("bro_messages"."action" = 'propose') = ("bro_messages"."proposal" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bro_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"target" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp (3) with time zone,
	CONSTRAINT "bro_reports_kind_check" CHECK ("bro_reports"."kind" IN ('invite_accepted', 'link_ready', 'question', 'held', 'agreed', 'confirmed', 'declined', 'answered', 'alert', 'expired', 'stalled', 'cancelled', 'link_removed')),
	CONSTRAINT "bro_reports_status_check" CHECK ("bro_reports"."status" IN ('pending', 'leased', 'delivered', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "bro_thread_sides" (
	"thread_id" uuid NOT NULL,
	"side" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mandate" jsonb,
	"owner_answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waiting_owner" boolean DEFAULT false NOT NULL,
	"pending_question" jsonb,
	"held_message" jsonb,
	"confirmed_proposal_id" uuid,
	"confirmed_at" timestamp (3) with time zone,
	"declined_at" timestamp (3) with time zone,
	"alerted_categories" text[] DEFAULT '{}' NOT NULL,
	"report_target" jsonb,
	"calendar_state" text,
	"calendar_event_id" text,
	"calendar_attempts" integer DEFAULT 0 NOT NULL,
	"calendar_next_at" timestamp (3) with time zone,
	CONSTRAINT "bro_thread_sides_pkey" PRIMARY KEY("thread_id","side"),
	CONSTRAINT "bro_thread_sides_side_check" CHECK ("bro_thread_sides"."side" IN ('initiator', 'responder')),
	CONSTRAINT "bro_thread_sides_mandate_check" CHECK ("bro_thread_sides"."mandate" IS NULL OR "bro_thread_sides"."side" = 'initiator'),
	CONSTRAINT "bro_thread_sides_calendar_state_check" CHECK ("bro_thread_sides"."calendar_state" IN ('pending', 'created', 'skipped_no_calendar', 'skipped_read_only', 'skipped_no_time', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "bro_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"initiator_workspace_id" text NOT NULL,
	"responder_workspace_id" text NOT NULL,
	"topic" text,
	"status" text DEFAULT 'negotiating' NOT NULL,
	"next_side" text,
	"next_at" timestamp (3) with time zone,
	"lease_token" text,
	"lease_expires_at" timestamp (3) with time zone,
	"agreed_proposal_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"envoy_messages" integer DEFAULT 0 NOT NULL,
	"failed_steps" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	CONSTRAINT "bro_threads_status_check" CHECK ("bro_threads"."status" IN ('negotiating', 'agreed', 'confirmed', 'answered', 'declined', 'cancelled', 'expired', 'stalled')),
	CONSTRAINT "bro_threads_next_side_check" CHECK ("bro_threads"."next_side" IN ('initiator', 'responder')),
	CONSTRAINT "bro_threads_pair_check" CHECK ("bro_threads"."initiator_workspace_id" <> "bro_threads"."responder_workspace_id"),
	CONSTRAINT "bro_threads_closed_check" CHECK (("bro_threads"."closed_at" IS NULL) = ("bro_threads"."status" IN ('negotiating', 'agreed')))
);
--> statement-breakpoint
ALTER TABLE "bro_invites" ADD CONSTRAINT "bro_invites_inviter_workspace_id_fkey" FOREIGN KEY ("inviter_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_invites" ADD CONSTRAINT "bro_invites_opened_by_workspace_id_fkey" FOREIGN KEY ("opened_by_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_links" ADD CONSTRAINT "bro_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_links" ADD CONSTRAINT "bro_links_peer_workspace_id_fkey" FOREIGN KEY ("peer_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_links" ADD CONSTRAINT "bro_links_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "public"."bro_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_messages" ADD CONSTRAINT "bro_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."bro_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_reports" ADD CONSTRAINT "bro_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_reports" ADD CONSTRAINT "bro_reports_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."bro_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_thread_sides" ADD CONSTRAINT "bro_thread_sides_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."bro_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_thread_sides" ADD CONSTRAINT "bro_thread_sides_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_threads" ADD CONSTRAINT "bro_threads_initiator_workspace_id_fkey" FOREIGN KEY ("initiator_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bro_threads" ADD CONSTRAINT "bro_threads_responder_workspace_id_fkey" FOREIGN KEY ("responder_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bro_invites_token_hash_uidx" ON "bro_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "bro_invites_inviter_created_idx" ON "bro_invites" USING btree ("inviter_workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "bro_invites_opened_idx" ON "bro_invites" USING btree ("opened_by_workspace_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bro_links_live_pair_uidx" ON "bro_links" USING btree ("workspace_id","peer_workspace_id") WHERE "bro_links"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bro_messages_thread_seq_uidx" ON "bro_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "bro_messages_created_idx" ON "bro_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bro_reports_dedupe_key_uidx" ON "bro_reports" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "bro_reports_due_idx" ON "bro_reports" USING btree ("created_at") WHERE "bro_reports"."status" IN ('pending', 'leased');--> statement-breakpoint
CREATE INDEX "bro_thread_sides_workspace_idx" ON "bro_thread_sides" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bro_thread_sides_calendar_due_idx" ON "bro_thread_sides" USING btree ("calendar_next_at") WHERE "bro_thread_sides"."calendar_state" = 'pending';--> statement-breakpoint
CREATE INDEX "bro_threads_due_idx" ON "bro_threads" USING btree ("next_at") WHERE "bro_threads"."status" = 'negotiating';--> statement-breakpoint
CREATE INDEX "bro_threads_deadline_idx" ON "bro_threads" USING btree ("deadline_at") WHERE "bro_threads"."status" IN ('negotiating', 'agreed');--> statement-breakpoint
CREATE INDEX "bro_threads_pair_created_idx" ON "bro_threads" USING btree ("initiator_workspace_id","responder_workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "bro_threads_closed_idx" ON "bro_threads" USING btree ("closed_at") WHERE "bro_threads"."closed_at" IS NOT NULL;