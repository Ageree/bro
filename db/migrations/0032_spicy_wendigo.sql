-- Idempotent: every statement leaves what an earlier run already did as it is.
ALTER TABLE "browser_runs" ADD COLUMN IF NOT EXISTS "queue_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proactive_watches" ADD COLUMN IF NOT EXISTS "messenger_channel" text;--> statement-breakpoint
ALTER TABLE "proactive_watches" ADD COLUMN IF NOT EXISTS "messenger_conversation_id" text;--> statement-breakpoint
ALTER TABLE "proactive_watches" ADD COLUMN IF NOT EXISTS "web_conversation_id" text;--> statement-breakpoint
-- The hidden job followed the latest chat of any kind, so it names the latest
-- messenger or the latest web chat.
UPDATE "proactive_watches" AS "watch"
SET "messenger_channel" = "job"."conversation_channel",
	"messenger_conversation_id" = "job"."conversation_id"
FROM "scheduled_agent_jobs" AS "job"
WHERE "job"."id" = "watch"."job_id"
	AND "job"."conversation_channel" IN ('photon', 'telegram')
	AND "watch"."messenger_channel" IS NULL;--> statement-breakpoint
UPDATE "proactive_watches" AS "watch"
SET "web_conversation_id" = "job"."conversation_id"
FROM "scheduled_agent_jobs" AS "job"
WHERE "job"."id" = "watch"."job_id"
	AND "job"."conversation_channel" = 'eve'
	AND "watch"."web_conversation_id" IS NULL;--> statement-breakpoint
-- A person whose hidden job had moved to the web chat still has the messenger
-- they used before: the newest one a schedule, an errand or a linked Telegram
-- account names.
WITH "candidates" AS (
	SELECT "workspace_id", "conversation_channel", "conversation_id", "updated_at" AS "seen_at"
	FROM "scheduled_agent_jobs"
	WHERE "kind" = 'task' AND "conversation_channel" IN ('photon', 'telegram')
	UNION ALL
	SELECT "workspace_id", "conversation_channel", "conversation_id", "created_at"
	FROM "browser_runs"
	WHERE "conversation_channel" IN ('photon', 'telegram')
	UNION ALL
	SELECT "workspace_id", 'telegram', "chat_id" || '::', "linked_at"
	FROM "channel_identities"
	WHERE "channel" = 'telegram' AND "chat_id" <> ''
), "latest" AS (
	SELECT DISTINCT ON ("workspace_id") "workspace_id", "conversation_channel", "conversation_id"
	FROM "candidates"
	WHERE "conversation_id" <> ''
	ORDER BY "workspace_id", "seen_at" DESC
)
UPDATE "proactive_watches" AS "watch"
SET "messenger_channel" = "latest"."conversation_channel",
	"messenger_conversation_id" = "latest"."conversation_id"
FROM "latest"
WHERE "latest"."workspace_id" = "watch"."workspace_id"
	AND "watch"."messenger_channel" IS NULL;--> statement-breakpoint
-- A messenger has pushes; the web chat is the target only without one.
UPDATE "scheduled_agent_jobs" AS "job"
SET "conversation_channel" = "watch"."messenger_channel",
	"conversation_id" = "watch"."messenger_conversation_id",
	"reply_anchor_message_id" = NULL,
	"updated_at" = now()
FROM "proactive_watches" AS "watch"
WHERE "watch"."job_id" = "job"."id"
	AND "job"."conversation_channel" = 'eve'
	AND "watch"."messenger_channel" IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.proactive_watches'::regclass AND conname = 'proactive_watches_messenger_check') THEN
		ALTER TABLE "proactive_watches" ADD CONSTRAINT "proactive_watches_messenger_check" CHECK (("proactive_watches"."messenger_channel" IS NULL AND "proactive_watches"."messenger_conversation_id" IS NULL) OR ("proactive_watches"."messenger_channel" IN ('photon', 'telegram') AND "proactive_watches"."messenger_conversation_id" <> ''));
	END IF;
END $$;
