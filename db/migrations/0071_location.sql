CREATE TABLE "location_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"accuracy_m" integer,
	"label" text,
	"address" text,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"live_key" text,
	"external_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_points_kind_check" CHECK ("location_points"."kind" IN ('position', 'place')),
	CONSTRAINT "location_points_source_check" CHECK ("location_points"."source" IN ('telegram', 'telegram_venue', 'telegram_live', 'imessage', 'web')),
	CONSTRAINT "location_points_coordinates_check" CHECK ("location_points"."lat" BETWEEN -90 AND 90 AND "location_points"."lon" BETWEEN -180 AND 180),
	CONSTRAINT "location_points_accuracy_check" CHECK ("location_points"."accuracy_m" IS NULL OR "location_points"."accuracy_m" >= 0),
	CONSTRAINT "location_points_label_check" CHECK ("location_points"."label" IS NULL OR length("location_points"."label") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_template_check";--> statement-breakpoint
ALTER TABLE "location_points" ADD CONSTRAINT "location_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_points_workspace_time_idx" ON "location_points" USING btree ("workspace_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "location_points_live_idx" ON "location_points" USING btree ("live_key","recorded_at" DESC NULLS LAST) WHERE "location_points"."live_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "location_points_expiry_idx" ON "location_points" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "location_points_external_uidx" ON "location_points" USING btree ("workspace_id","external_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_template_check" CHECK ("subscriptions"."template" IN ('price', 'flight', 'place'));