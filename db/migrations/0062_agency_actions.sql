CREATE TABLE "agency_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text,
	"tool" text NOT NULL,
	"action_class" text NOT NULL,
	"counterparty" text,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"summary" text NOT NULL,
	"undo" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_actions_action_class_check" CHECK ("agency_actions"."action_class" IN ('send', 'calendar', 'call', 'submit', 'other')),
	CONSTRAINT "agency_actions_status_check" CHECK ("agency_actions"."status" IN ('planned', 'done', 'failed', 'undone'))
);
--> statement-breakpoint
ALTER TABLE "proactive_signals" DROP CONSTRAINT "proactive_signals_source_check";--> statement-breakpoint
ALTER TABLE "agency_actions" ADD CONSTRAINT "agency_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_actions_idempotency_uidx" ON "agency_actions" USING btree ("workspace_id","input_hash");--> statement-breakpoint
CREATE INDEX "agency_actions_workspace_created_idx" ON "agency_actions" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "proactive_signals" ADD CONSTRAINT "proactive_signals_source_check" CHECK ("proactive_signals"."source" IN ('gmail', 'calendar', 'agent_mail', 'phone', 'browser', 'calendar_prep', 'sweep'));