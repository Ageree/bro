CREATE TABLE "capability_tips" (
	"workspace_id" text NOT NULL,
	"capability" text NOT NULL,
	"offered_at" timestamp (3) with time zone NOT NULL,
	"offers" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "capability_tips_workspace_id_capability_pk" PRIMARY KEY("workspace_id","capability")
);
--> statement-breakpoint
ALTER TABLE "capability_tips" ADD CONSTRAINT "capability_tips_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;