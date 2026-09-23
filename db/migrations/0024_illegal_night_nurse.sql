CREATE TABLE "proactive_signals" (
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"item_id" text NOT NULL,
	"thread_id" text,
	"run_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_signals_pkey" PRIMARY KEY("workspace_id","source","dedupe_key"),
	CONSTRAINT "proactive_signals_source_check" CHECK ("proactive_signals"."source" IN ('gmail', 'calendar'))
);
--> statement-breakpoint
CREATE TABLE "proactive_watches" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"mail_checked_at" timestamp (3) with time zone NOT NULL,
	"next_check_at" timestamp (3) with time zone NOT NULL,
	"google_state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_watches_google_state_check" CHECK ("proactive_watches"."google_state" IN ('unknown', 'connected', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN "kind" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "proactive_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_signals" ADD CONSTRAINT "proactive_signals_run_id_scheduled_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scheduled_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_signals" ADD CONSTRAINT "proactive_signals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_watches" ADD CONSTRAINT "proactive_watches_job_id_scheduled_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_watches" ADD CONSTRAINT "proactive_watches_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proactive_signals_run_idx" ON "proactive_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "proactive_signals_created_idx" ON "proactive_signals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "proactive_watches_due_idx" ON "proactive_watches" USING btree ("next_check_at");--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_kind_check" CHECK ("scheduled_agent_jobs"."kind" IN ('task', 'proactive'));