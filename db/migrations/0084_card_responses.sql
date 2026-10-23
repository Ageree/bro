CREATE TABLE "card_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"values" jsonb NOT NULL,
	"summary" text NOT NULL,
	"telegram_user_id" text NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_responses_state_check" CHECK ("card_responses"."state" IN ('received', 'delivered', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "ref" text;--> statement-breakpoint
UPDATE "cards" SET "ref" = substr(translate(md5("id"), '01', 'kz'), 1, 8) WHERE "ref" IS NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "conversation_channel" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "card_responses" ADD CONSTRAINT "card_responses_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_responses" ADD CONSTRAINT "card_responses_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_responses_card_revision_idx" ON "card_responses" USING btree ("card_id","revision");--> statement-breakpoint
CREATE INDEX "card_responses_received_idx" ON "card_responses" USING btree ("created_at") WHERE "card_responses"."state" = 'received';--> statement-breakpoint
CREATE INDEX "card_responses_workspace_created_idx" ON "card_responses" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_ref_idx" ON "cards" USING btree ("ref");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_conversation_channel_check" CHECK ("cards"."conversation_channel" IN ('telegram'));