CREATE TABLE "agent_mail_sends" (
	"workspace_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"message_id" text,
	"thread_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mail_sends_pkey" PRIMARY KEY("workspace_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "agent_mailboxes" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mail_sends" ADD CONSTRAINT "agent_mail_sends_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_mailboxes_inbox_id_uidx" ON "agent_mailboxes" USING btree ("inbox_id");