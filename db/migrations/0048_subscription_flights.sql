ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_template_check";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_action_check";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_template_check" CHECK ("subscriptions"."template" IN ('price', 'flight'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_action_check" CHECK ("subscriptions"."action" IN ('notify', 'worker'));
