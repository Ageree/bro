ALTER TABLE "browser_site_operations" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_site_operations" ADD COLUMN "failed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_site_operations" ADD COLUMN "last_failure" text;--> statement-breakpoint
ALTER TABLE "browser_site_operations" ADD COLUMN "served" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_site_operations" ADD CONSTRAINT "browser_site_operations_last_failure_check" CHECK ("browser_site_operations"."last_failure" IS NULL OR "browser_site_operations"."last_failure" IN ('blocked', 'moved', 'no_data', 'empty', 'unanswered', 'failed'));