CREATE TABLE "yoomoney_onboardings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"device_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	CONSTRAINT "yoomoney_onboardings_conversation_channel_check" CHECK ("yoomoney_onboardings"."conversation_channel" IN ('eve', 'photon', 'telegram'))
);
--> statement-breakpoint
ALTER TABLE "yoomoney_authorizations" ADD COLUMN "onboarding_id" uuid;--> statement-breakpoint
ALTER TABLE "yoomoney_onboardings" ADD CONSTRAINT "yoomoney_onboardings_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yoomoney_authorizations" ADD CONSTRAINT "yoomoney_authorizations_onboarding_id_yoomoney_onboardings_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."yoomoney_onboardings"("id") ON DELETE cascade ON UPDATE no action;