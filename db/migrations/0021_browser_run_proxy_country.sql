ALTER TABLE "browser_runs" ADD COLUMN "proxy_country_code" text;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_proxy_country_code_check" CHECK ("browser_runs"."proxy_country_code" IS NULL OR "browser_runs"."proxy_country_code" ~ '^[a-z]{2}$');
