CREATE TABLE "channel_identities" (
	"channel" text NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"linked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_identities_pkey" PRIMARY KEY("channel","external_user_id"),
	CONSTRAINT "channel_identities_channel_check" CHECK ("channel_identities"."channel" IN ('telegram'))
);
--> statement-breakpoint
CREATE TABLE "channel_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_tokens_channel_check" CHECK ("channel_link_tokens"."channel" IN ('telegram'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP CONSTRAINT "scheduled_agent_jobs_conversation_channel_check";--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_account_idx" ON "channel_identities" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "channel_identities_workspace_idx" ON "channel_identities" USING btree ("workspace_id","channel");--> statement-breakpoint
CREATE INDEX "channel_link_tokens_expiry_idx" ON "channel_link_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_conversation_channel_check" CHECK ("scheduled_agent_jobs"."conversation_channel" IN ('eve', 'photon', 'telegram'));