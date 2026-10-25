CREATE TABLE "browser_site_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"operation" jsonb NOT NULL,
	"runs" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_site_operations_name_check" CHECK (char_length("browser_site_operations"."name") BETWEEN 1 AND 160)
);
--> statement-breakpoint
ALTER TABLE "browser_site_operations" ADD CONSTRAINT "browser_site_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_site_operations_workspace_name_uidx" ON "browser_site_operations" USING btree ("workspace_id","name");