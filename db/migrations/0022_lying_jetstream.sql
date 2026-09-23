CREATE TABLE "operational_alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp (3) with time zone,
	"last_value" numeric(16, 8),
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "introduced_at" timestamp (3) with time zone;--> statement-breakpoint
-- Every workspace that exists before this column has already met Bro, or was
-- migrated from Convex with its history, so none of them is introduced again.
UPDATE "workspaces" SET "introduced_at" = now() WHERE "introduced_at" IS NULL;
