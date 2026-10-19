ALTER TABLE "yoomoney_payments" ADD COLUMN "conversation_channel" text;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "outcome_told_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD CONSTRAINT "yoomoney_payments_conversation_channel_check" CHECK ("yoomoney_payments"."conversation_channel" IN ('eve', 'photon', 'telegram'));