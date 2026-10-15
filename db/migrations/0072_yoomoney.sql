CREATE TABLE "yoomoney_authorizations" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yoomoney_connections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account" text NOT NULL,
	"scope" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yoomoney_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"request_params" jsonb NOT NULL,
	"shown" jsonb NOT NULL,
	"request_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"test" boolean NOT NULL,
	"state" text DEFAULT 'quoted' NOT NULL,
	"confirmation_question" text NOT NULL,
	"payment_id" text,
	"error" text,
	"call_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "yoomoney_payments_kind_check" CHECK ("yoomoney_payments"."kind" IN ('transfer', 'service')),
	CONSTRAINT "yoomoney_payments_state_check" CHECK ("yoomoney_payments"."state" IN ('quoted', 'submitting', 'pending', 'unknown', 'paid', 'refused')),
	CONSTRAINT "yoomoney_payments_amount_check" CHECK ("yoomoney_payments"."amount_minor" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "yoomoney_authorizations" ADD CONSTRAINT "yoomoney_authorizations_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yoomoney_connections" ADD CONSTRAINT "yoomoney_connections_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD CONSTRAINT "yoomoney_payments_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "yoomoney_payments_in_flight_uidx" ON "yoomoney_payments" USING btree ("workspace_id") WHERE "yoomoney_payments"."state" IN ('submitting', 'pending', 'unknown');