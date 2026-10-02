-- Idempotent: a second run leaves what an earlier run created as it is.
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"template" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"source" jsonb NOT NULL,
	"condition" jsonb NOT NULL,
	"action" text DEFAULT 'notify' NOT NULL,
	"wake" text DEFAULT 'day_only' NOT NULL,
	"state" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"check_every_s" integer NOT NULL,
	"next_check_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp (3) with time zone,
	"last_hit_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_template_check" CHECK ("subscriptions"."template" IN ('price')),
	CONSTRAINT "subscriptions_action_check" CHECK ("subscriptions"."action" IN ('notify')),
	CONSTRAINT "subscriptions_wake_check" CHECK ("subscriptions"."wake" IN ('day_only', 'urgent_at_night')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" IN ('active', 'paused', 'fired', 'expired', 'failed', 'cancelled')),
	CONSTRAINT "subscriptions_json_check" CHECK (jsonb_typeof("subscriptions"."source") = 'object' AND jsonb_typeof("subscriptions"."condition") = 'object' AND jsonb_typeof("subscriptions"."state") = 'object'),
	CONSTRAINT "subscriptions_dedupe_key_check" CHECK ("subscriptions"."dedupe_key" <> ''),
	CONSTRAINT "subscriptions_check_every_check" CHECK ("subscriptions"."check_every_s" >= 3600),
	CONSTRAINT "subscriptions_expires_check" CHECK ("subscriptions"."expires_at" > "subscriptions"."created_at" AND "subscriptions"."expires_at" <= "subscriptions"."created_at" + interval '90 days')
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP CONSTRAINT IF EXISTS "scheduled_agent_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_job_id_scheduled_agent_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_job_id_scheduled_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_membership_fkey";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_due_idx" ON "subscriptions" USING btree ("next_check_at") WHERE "subscriptions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_job_idx" ON "subscriptions" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_live_idx" ON "subscriptions" USING btree ("workspace_id","template","dedupe_key") WHERE "subscriptions"."status" IN ('active', 'paused');--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP CONSTRAINT IF EXISTS "scheduled_agent_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_kind_check" CHECK ("scheduled_agent_jobs"."kind" IN ('task', 'proactive', 'subscription'));