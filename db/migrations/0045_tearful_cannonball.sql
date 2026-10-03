CREATE TABLE IF NOT EXISTS "memory_digest_runs" (
	"workspace_id" text NOT NULL,
	"local_date" date NOT NULL,
	"status" text NOT NULL,
	"lease_until" timestamp (3) with time zone NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"outcome" jsonb,
	"error_code" text,
	CONSTRAINT "memory_digest_runs_workspace_id_local_date_pk" PRIMARY KEY("workspace_id","local_date"),
	CONSTRAINT "memory_digest_runs_status_check" CHECK ("memory_digest_runs"."status" IN ('running', 'done', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_digest_runs" ADD CONSTRAINT "memory_digest_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_digest_runs_day_idx" ON "memory_digest_runs" USING btree ("local_date","status");
