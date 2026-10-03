CREATE TABLE IF NOT EXISTS "memory_revisions" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"record_index" bigint NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"session_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_workspace_id_scope_key_record_index_revision_pk" PRIMARY KEY("workspace_id","scope_key","record_index","revision"),
	CONSTRAINT "memory_revisions_action_check" CHECK ("memory_revisions"."action" IN ('save', 'update', 'restore', 'forget', 'expire', 'import', 'merge', 'correct', 'one_off', 'purge')),
	CONSTRAINT "memory_revisions_actor_check" CHECK ("memory_revisions"."actor" IN ('model', 'person', 'digest', 'system')),
	CONSTRAINT "memory_revisions_index_check" CHECK ("memory_revisions"."record_index" >= 0),
	CONSTRAINT "memory_revisions_revision_check" CHECK ("memory_revisions"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD COLUMN IF NOT EXISTS "last_recalled_at" timestamp (3) with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_revisions_timeline_idx" ON "memory_revisions" USING btree ("workspace_id","scope_key","created_at");--> statement-breakpoint
-- History starts with what each memory says today.
INSERT INTO "memory_revisions" ("workspace_id", "scope_key", "record_index", "revision", "content", "action", "actor", "created_at")
SELECT "workspace_id", "scope_key", "record_index", "revision", "content", 'import', 'system', "updated_at"
FROM "memory_records"
WHERE "content" IS NOT NULL
ON CONFLICT DO NOTHING;
