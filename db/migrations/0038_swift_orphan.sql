CREATE TABLE "usage_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"units" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_rub" numeric(14, 6) NOT NULL,
	"cost_usd" numeric(14, 8),
	"run_id" text,
	"session_id" text,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "usage_costs_idempotency_key_uidx" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_costs_source_check" CHECK ("usage_costs"."source" IN ('chat', 'background', 'browser-report', 'browser-run', 'browser-vm', 'proxy')),
	CONSTRAINT "usage_costs_cost_rub_check" CHECK ("usage_costs"."cost_rub" >= 0),
	CONSTRAINT "usage_costs_cost_usd_check" CHECK ("usage_costs"."cost_usd" IS NULL OR "usage_costs"."cost_usd" >= 0),
	CONSTRAINT "usage_costs_idempotency_key_check" CHECK ("usage_costs"."idempotency_key" <> '')
);
--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "powered_on_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "usage_costs" ADD CONSTRAINT "usage_costs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_costs_occurred_idx" ON "usage_costs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "usage_costs_run_idx" ON "usage_costs" USING btree ("run_id");