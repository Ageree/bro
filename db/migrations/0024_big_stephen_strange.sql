CREATE TABLE "spend_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"browser_run_id" text NOT NULL,
	"period_key" text NOT NULL,
	"merchant" text,
	"category" text,
	"amount_rub" integer NOT NULL,
	"fee_rub" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_entries_browser_run_uidx" UNIQUE("browser_run_id"),
	CONSTRAINT "spend_entries_status_check" CHECK ("spend_entries"."status" IN ('reserved', 'charged', 'released')),
	CONSTRAINT "spend_entries_amounts_check" CHECK ("spend_entries"."amount_rub" >= 0 AND "spend_entries"."fee_rub" >= 0),
	CONSTRAINT "spend_entries_period_key_check" CHECK ("spend_entries"."period_key" <> '')
);
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_key_check";--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "payment_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "captcha_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "retry_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "retried_as_run_id" text;--> statement-breakpoint
ALTER TABLE "spend_entries" ADD CONSTRAINT "spend_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_entries_period_idx" ON "spend_entries" USING btree ("workspace_id","period_key");--> statement-breakpoint
CREATE INDEX "browser_runs_retry_idx" ON "browser_runs" USING btree ("retry_at");--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_captcha_attempt_check" CHECK ("browser_runs"."captcha_attempt" >= 1);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_key_check" CHECK ("settings"."key" IN ('gateway_model', 'google_workspace_access', 'spend_limit'));