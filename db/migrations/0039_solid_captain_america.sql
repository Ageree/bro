ALTER TABLE "browser_runs" ADD COLUMN "started_by_person" boolean;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "stop_not_before" timestamp (3) with time zone;