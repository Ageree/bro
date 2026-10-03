CREATE TABLE IF NOT EXISTS "conversation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_log_text_check" CHECK (char_length("conversation_log"."text") BETWEEN 1 AND 500)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation_log" ADD CONSTRAINT "conversation_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_log_workspace_created_idx" ON "conversation_log" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_log_created_idx" ON "conversation_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_log_turn_line_uidx" ON "conversation_log" USING btree ("session_id","turn_id",md5("text"));