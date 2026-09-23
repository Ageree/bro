ALTER TABLE "browser_runs" ADD COLUMN "report" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "report_delivered_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "report_claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "report_attempts" integer DEFAULT 0 NOT NULL;