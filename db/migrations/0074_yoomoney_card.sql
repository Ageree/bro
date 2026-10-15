ALTER TABLE "yoomoney_payments" ADD COLUMN "card_id" text;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "card_label" text;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "csc_required" boolean;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "bank_uri" text;--> statement-breakpoint
ALTER TABLE "yoomoney_payments" ADD COLUMN "bank_params" jsonb;