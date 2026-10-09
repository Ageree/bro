CREATE TABLE "login_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"domain" text NOT NULL,
	"site_url" text NOT NULL,
	"allowed_domains" text[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"worker_id" text,
	"device_hash" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"claimed_at" timestamp (3) with time zone,
	"view_until" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"result_host" text,
	"signed_in" boolean,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"reply_anchor_message_id" text,
	"root_session_id" text,
	"report" text,
	"report_claimed_at" timestamp (3) with time zone,
	"report_delivered_at" timestamp (3) with time zone,
	"report_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "login_handoffs_state_check" CHECK ("login_handoffs"."state" IN ('pending', 'claimed', 'done', 'cancelled', 'expired', 'failed')),
	CONSTRAINT "login_handoffs_conversation_channel_check" CHECK ("login_handoffs"."conversation_channel" IN ('eve', 'photon', 'telegram')),
	CONSTRAINT "login_handoffs_domain_check" CHECK ("login_handoffs"."domain" <> '')
);
--> statement-breakpoint
ALTER TABLE "login_handoffs" ADD CONSTRAINT "login_handoffs_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_handoffs_workspace_idx" ON "login_handoffs" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "login_handoffs_state_idx" ON "login_handoffs" USING btree ("state","expires_at");