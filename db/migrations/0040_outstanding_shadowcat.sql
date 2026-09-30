CREATE TABLE "browser_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"vm_id" text,
	"vm_name" text NOT NULL,
	"address" text,
	"floating_ip_id" text,
	"capacity" jsonb,
	"last_seen_at" timestamp (3) with time zone,
	"empty_since" timestamp (3) with time zone,
	"last_error" text,
	"lease_until" timestamp (3) with time zone,
	"state_changed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_hosts_state_check" CHECK ("browser_hosts"."state" IN ('creating', 'booting', 'ready', 'draining', 'deleting', 'failed')),
	CONSTRAINT "browser_hosts_id_check" CHECK ("browser_hosts"."id" ~ '^[a-z0-9-]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "sandbox_state" text;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "host_id" text;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "snapshot_key" text;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "snapshot_generation" integer;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "snapshot_chunks" integer;--> statement-breakpoint
ALTER TABLE "browser_vms" ADD COLUMN "snapshot_format" text;--> statement-breakpoint
CREATE INDEX "browser_hosts_state_idx" ON "browser_hosts" USING btree ("state","state_changed_at");--> statement-breakpoint
ALTER TABLE "browser_vms" ADD CONSTRAINT "browser_vms_host_id_browser_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."browser_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_vms_host_idx" ON "browser_vms" USING btree ("host_id");--> statement-breakpoint
ALTER TABLE "browser_vms" ADD CONSTRAINT "browser_vms_sandbox_state_check" CHECK ("browser_vms"."sandbox_state" IS NULL OR "browser_vms"."sandbox_state" IN ('absent', 'starting', 'running', 'parking', 'parked', 'restoring', 'cold', 'failed'));--> statement-breakpoint
ALTER TABLE "browser_vms" ADD CONSTRAINT "browser_vms_snapshot_generation_check" CHECK ("browser_vms"."snapshot_generation" IS NULL OR "browser_vms"."snapshot_generation" >= 0);--> statement-breakpoint
ALTER TABLE "browser_vms" ADD CONSTRAINT "browser_vms_snapshot_chunks_check" CHECK ("browser_vms"."snapshot_chunks" IS NULL OR "browser_vms"."snapshot_chunks" >= 1);