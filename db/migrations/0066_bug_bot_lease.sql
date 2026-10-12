ALTER TABLE "bug_bot_state" ADD COLUMN "lease_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "bug_bot_state" ADD COLUMN "failed_update_id" bigint;--> statement-breakpoint
ALTER TABLE "bug_bot_state" ADD COLUMN "failed_count" integer DEFAULT 0 NOT NULL;