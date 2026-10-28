CREATE TABLE "work_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"channel" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"files" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_log_role_check" CHECK ("work_log"."role" IN ('person', 'bro')),
	CONSTRAINT "work_log_text_check" CHECK (char_length("work_log"."text") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "work_log" ADD CONSTRAINT "work_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_log_workspace_created_idx" ON "work_log" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "work_log_created_idx" ON "work_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_log_turn_line_uidx" ON "work_log" USING btree ("session_id","turn_id","role",md5("text"));