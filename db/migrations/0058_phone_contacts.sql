CREATE TABLE "phone_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"phones" text[] NOT NULL,
	"note" text,
	"familiar" boolean DEFAULT true NOT NULL,
	"search_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_contacts" ADD CONSTRAINT "phone_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_contacts_workspace_name_unique" ON "phone_contacts" USING btree ("workspace_id","search_key");--> statement-breakpoint
CREATE INDEX "phone_contacts_workspace_idx" ON "phone_contacts" USING btree ("workspace_id");