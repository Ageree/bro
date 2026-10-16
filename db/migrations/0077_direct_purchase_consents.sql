CREATE TABLE "direct_purchase_consents" (
	"workspace_id" text NOT NULL,
	"consent_key" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_purchase_consents_key_uidx" UNIQUE("workspace_id","consent_key")
);
--> statement-breakpoint
ALTER TABLE "direct_purchase_consents" ADD CONSTRAINT "direct_purchase_consents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;