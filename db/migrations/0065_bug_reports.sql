CREATE TABLE "bug_bot_state" (
	"id" text PRIMARY KEY NOT NULL,
	"next_offset" bigint NOT NULL,
	"paused_until" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "bug_report_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bug_report_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"report_id" integer NOT NULL,
	"update_id" bigint NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bug_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"update_id" bigint NOT NULL,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"workspace_id" text,
	"text" text NOT NULL,
	"photo_file_id" text,
	"status" text DEFAULT 'new' NOT NULL,
	"forward_message_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report_replies" ADD CONSTRAINT "bug_report_replies_report_id_bug_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bug_report_replies_update_id_idx" ON "bug_report_replies" USING btree ("update_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bug_reports_update_id_idx" ON "bug_reports" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "bug_reports_user_created_idx" ON "bug_reports" USING btree ("telegram_user_id","created_at");--> statement-breakpoint
CREATE INDEX "bug_reports_forward_message_idx" ON "bug_reports" USING btree ("forward_message_id");