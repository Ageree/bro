CREATE TABLE "turn_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"run_id" text,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"duration_ms" integer,
	"steps" integer DEFAULT 0 NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"cost_rub" numeric(14, 6) DEFAULT 0 NOT NULL,
	CONSTRAINT "turn_log_kind_check" CHECK ("turn_log"."kind" IN ('person', 'browser-report', 'background', 'task')),
	CONSTRAINT "turn_log_outcome_check" CHECK ("turn_log"."outcome" IN ('running', 'completed', 'failed', 'cancelled', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "turn_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"event_id" text NOT NULL,
	"part" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"tool_name" text,
	"text" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "turn_log_entries_role_check" CHECK ("turn_log_entries"."role" IN ('person', 'input', 'bro', 'tool-call', 'tool-result')),
	CONSTRAINT "turn_log_entries_text_check" CHECK (char_length("turn_log_entries"."text") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "turn_log" ADD CONSTRAINT "turn_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_log_entries" ADD CONSTRAINT "turn_log_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_log_turn_uidx" ON "turn_log" USING btree ("session_id","turn_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_log_open_turn_uidx" ON "turn_log" USING btree ("session_id","turn_id") WHERE "turn_log"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "turn_log_workspace_started_idx" ON "turn_log" USING btree ("workspace_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turn_log_started_idx" ON "turn_log" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_log_entries_event_uidx" ON "turn_log_entries" USING btree ("event_id","part");--> statement-breakpoint
CREATE INDEX "turn_log_entries_turn_idx" ON "turn_log_entries" USING btree ("session_id","turn_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_log_entries_created_idx" ON "turn_log_entries" USING btree ("created_at");