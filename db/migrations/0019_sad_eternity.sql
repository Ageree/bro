CREATE TABLE "memory_operations" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"operation_id" text NOT NULL,
	"record_index" bigint NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_operations_workspace_id_scope_key_operation_id_pk" PRIMARY KEY("workspace_id","scope_key","operation_id"),
	CONSTRAINT "memory_operations_index_check" CHECK ("memory_operations"."record_index" >= 0),
	CONSTRAINT "memory_operations_revision_check" CHECK ("memory_operations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"record_index" bigint NOT NULL,
	"revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"content" jsonb,
	"last_operation_id" text NOT NULL,
	"source_session_id" text,
	"source_turn_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_records_workspace_id_scope_key_record_index_pk" PRIMARY KEY("workspace_id","scope_key","record_index"),
	CONSTRAINT "memory_records_index_check" CHECK ("memory_records"."record_index" >= 0),
	CONSTRAINT "memory_records_revision_check" CHECK ("memory_records"."revision" > 0),
	CONSTRAINT "memory_records_generation_check" CHECK ("memory_records"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_scopes" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"last_allocated_index" bigint DEFAULT -1 NOT NULL,
	"legacy_import_completed_at" timestamp (3) with time zone,
	"semantic_index_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_scopes_workspace_id_scope_key_pk" PRIMARY KEY("workspace_id","scope_key"),
	CONSTRAINT "memory_scopes_generation_check" CHECK ("memory_scopes"."generation" > 0),
	CONSTRAINT "memory_scopes_last_index_check" CHECK ("memory_scopes"."last_allocated_index" >= -1)
);
--> statement-breakpoint
CREATE TABLE "memory_sync" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"record_index" bigint NOT NULL,
	"revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"desired_present" boolean NOT NULL,
	"custom_id" text NOT NULL,
	"provider_document_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"last_error_code" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_sync_workspace_id_scope_key_record_index_revision_pk" PRIMARY KEY("workspace_id","scope_key","record_index","revision"),
	CONSTRAINT "memory_sync_attempts_check" CHECK ("memory_sync"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sync" ADD CONSTRAINT "memory_sync_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_operation_idx" ON "memory_records" USING btree ("workspace_id","scope_key","last_operation_id");--> statement-breakpoint
CREATE INDEX "memory_records_recent_idx" ON "memory_records" USING btree ("workspace_id","scope_key","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_sync_custom_id_idx" ON "memory_sync" USING btree ("custom_id");--> statement-breakpoint
CREATE INDEX "memory_sync_ready_idx" ON "memory_sync" USING btree ("status","next_attempt_at","desired_present");