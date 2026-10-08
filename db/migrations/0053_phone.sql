CREATE TABLE "phone_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"number_record_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"direction" text NOT NULL,
	"target" text,
	"task" text,
	"state" text NOT NULL,
	"provider_conversation_id" text,
	"duration_seconds" integer,
	"cost_usd" numeric,
	"carrier_rub" numeric,
	"outcome" text,
	"task_succeeded" boolean,
	"summary" text,
	"session_id" text,
	"conversation_id" text,
	"conversation_channel" text,
	"checked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"report_delivered_at" timestamp with time zone,
	"report_lease_token" text,
	"report_lease_until" timestamp with time zone,
	"report_attempts" integer DEFAULT 0 NOT NULL,
	"report_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_number_requests" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"last_failure" text,
	"session_id" text,
	"conversation_id" text,
	"conversation_channel" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"number" text NOT NULL,
	"state" text NOT NULL,
	"stage" text DEFAULT 'quoted' NOT NULL,
	"setup_rub" integer NOT NULL,
	"monthly_rub" integer NOT NULL,
	"sip_monthly_rub" integer NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"number_id" text,
	"sip_id" text,
	"phone_number_id" text,
	"outbound_phone_number_id" text,
	"agent_id" text,
	"session_id" text,
	"conversation_id" text,
	"conversation_channel" text,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_number_record_id_phone_numbers_id_fk" FOREIGN KEY ("number_record_id") REFERENCES "public"."phone_numbers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_number_requests" ADD CONSTRAINT "phone_number_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_operation_unique" ON "phone_calls" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_conversation_unique" ON "phone_calls" USING btree ("provider_conversation_id");--> statement-breakpoint
CREATE INDEX "phone_calls_workspace_created" ON "phone_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "phone_number_requests_due" ON "phone_number_requests" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_workspace_unique" ON "phone_numbers" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_number_unique" ON "phone_numbers" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_provider_unique" ON "phone_numbers" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_outbound_provider_unique" ON "phone_numbers" USING btree ("outbound_phone_number_id");