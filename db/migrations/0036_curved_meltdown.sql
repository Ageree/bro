CREATE TABLE "browser_vm_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"error" text,
	"final_url" text,
	"unread_messages" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_vm_runs_status_check" CHECK ("browser_vm_runs"."status" IN ('queued', 'dispatching', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "browser_vms" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"vm_id" text,
	"vm_name" text,
	"host" text,
	"floating_ip_id" text,
	"boot_disk_id" text,
	"image" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"profile_generation" integer DEFAULT 1 NOT NULL,
	"profile_reset_pending" boolean DEFAULT false NOT NULL,
	"proxy_session" text,
	"proxy_exit" jsonb,
	"last_used_at" timestamp (3) with time zone,
	"state_changed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"claimed_at" timestamp (3) with time zone,
	"given_up_at" timestamp (3) with time zone,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"health_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_vms_state_check" CHECK ("browser_vms"."state" IN ('creating', 'starting', 'ready', 'stopping', 'stopped', 'deleting', 'failed')),
	CONSTRAINT "browser_vms_generation_check" CHECK ("browser_vms"."generation" >= 0),
	CONSTRAINT "browser_vms_profile_generation_check" CHECK ("browser_vms"."profile_generation" >= 1),
	CONSTRAINT "browser_vms_recoveries_check" CHECK ("browser_vms"."recoveries" >= 0),
	CONSTRAINT "browser_vms_health_failures_check" CHECK ("browser_vms"."health_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "browser_vm_runs" ADD CONSTRAINT "browser_vm_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD CONSTRAINT "browser_vms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_vm_runs_workspace_idx" ON "browser_vm_runs" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "browser_vm_runs_session_idx" ON "browser_vm_runs" USING btree ("session_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "browser_vms_reconcile_idx" ON "browser_vms" USING btree ("state","state_changed_at");