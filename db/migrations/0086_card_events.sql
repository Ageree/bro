DROP INDEX "card_responses_card_revision_idx";--> statement-breakpoint
ALTER TABLE "card_responses" ADD COLUMN "kind" text DEFAULT 'submit' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_responses" ADD COLUMN "item" text;--> statement-breakpoint
ALTER TABLE "card_responses" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "card_responses" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "watched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "card_responses_card_created_idx" ON "card_responses" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "card_responses_run_idx" ON "card_responses" USING btree ("run_id") WHERE "card_responses"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "card_responses_card_revision_idx" ON "card_responses" USING btree ("card_id","revision") WHERE "card_responses"."kind" = 'submit';--> statement-breakpoint
ALTER TABLE "card_responses" ADD CONSTRAINT "card_responses_kind_check" CHECK ("card_responses"."kind" IN ('submit', 'intent'));