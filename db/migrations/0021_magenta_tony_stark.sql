ALTER TABLE "settings" DROP CONSTRAINT "settings_key_check";--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "scheduled_origin" jsonb;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "root_run_id" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "active_run_id" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_token" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_task" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_previous_run_id" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_recovery_token" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "lineage_recovery_claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "capability" text DEFAULT 'browse' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "verification_plan" jsonb;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "verification_report" jsonb;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "final_task_status" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "final_need" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_token" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_task" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "repair_deadline" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "delivery_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "delivery_token" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "delivery_claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "delivered_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "browser_runs" SET "root_run_id" = "id", "active_run_id" = "id" WHERE "root_run_id" IS NULL OR "active_run_id" IS NULL;--> statement-breakpoint
UPDATE "browser_runs" SET "delivery_state" = 'ambiguous' WHERE "completed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "pending_browser_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_capability_check" CHECK ("browser_runs"."capability" IN ('browse', 'prepare', 'purchase', 'send', 'account-change', 'delete'));--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_lineage_state_check" CHECK ("browser_runs"."lineage_state" IN ('active', 'claimed', 'creating', 'recovering', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_final_task_status_check" CHECK ("browser_runs"."final_task_status" IS NULL OR "browser_runs"."final_task_status" IN ('complete', 'partial', 'blocked', 'invalid'));--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_repair_state_check" CHECK ("browser_runs"."repair_state" IN ('none', 'claimed', 'creating', 'running', 'failed'));--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_delivery_state_check" CHECK ("browser_runs"."delivery_state" IN ('pending', 'claimed', 'acked', 'ambiguous'));--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_repair_count_check" CHECK ("browser_runs"."repair_count" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_key_check" CHECK ("settings"."key" IN ('gateway_model', 'browser_autonomy'));