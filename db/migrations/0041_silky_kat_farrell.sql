ALTER TABLE "browser_vms" ADD COLUMN "worker_failed_version" text;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "worker_rollout_at" timestamp (3) with time zone;