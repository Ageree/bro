-- Idempotent: every statement leaves what an earlier run already did as it is.
-- Every row written before this came from the spend limit, the only thing that
-- reserved money until card and standing-permission payments were recorded.
ALTER TABLE "spend_entries" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'limit' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.spend_entries'::regclass AND conname = 'spend_entries_source_check') THEN
		ALTER TABLE "spend_entries" ADD CONSTRAINT "spend_entries_source_check" CHECK ("spend_entries"."source" IN ('limit', 'card', 'standing'));
	END IF;
END $$;
