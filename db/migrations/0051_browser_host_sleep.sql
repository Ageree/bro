ALTER TABLE "browser_hosts" DROP CONSTRAINT "browser_hosts_state_check";--> statement-breakpoint
ALTER TABLE "browser_hosts" ADD COLUMN "boot_config" text;--> statement-breakpoint
ALTER TABLE "browser_hosts" ADD CONSTRAINT "browser_hosts_state_check" CHECK ("browser_hosts"."state" IN ('creating', 'booting', 'ready', 'draining', 'stopped', 'waking', 'deleting', 'failed'));