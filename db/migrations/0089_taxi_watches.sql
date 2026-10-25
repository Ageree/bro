CREATE TABLE "taxi_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"order_id" text NOT NULL,
	"for_passenger" boolean DEFAULT false NOT NULL,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"state" text DEFAULT 'watching' NOT NULL,
	"status" text,
	"car" text,
	"found_told_at" timestamp with time zone,
	"leave_told_at" timestamp with time zone,
	"arrived_told_at" timestamp with time zone,
	"next_check_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "taxi_watches_state_check" CHECK ("taxi_watches"."state" IN ('watching', 'done'))
);
--> statement-breakpoint
ALTER TABLE "taxi_watches" ADD CONSTRAINT "taxi_watches_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "taxi_watches_order_uidx" ON "taxi_watches" USING btree ("workspace_id","order_id");