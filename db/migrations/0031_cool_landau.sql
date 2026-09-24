ALTER TABLE "browser_runs" DROP CONSTRAINT IF EXISTS "browser_runs_status_check";--> statement-breakpoint
ALTER TABLE "browser_runs" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN IF NOT EXISTS "pending_task" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_status_check" CHECK ("browser_runs"."status" IN ('created', 'queued', 'running', 'waiting', 'done', 'failed', 'stopped'));
