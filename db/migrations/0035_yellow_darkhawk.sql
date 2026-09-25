CREATE TABLE "browser_sign_ins" (
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"account_url" text,
	"state" text NOT NULL,
	"used_at" timestamp (3) with time zone,
	"checked_at" timestamp (3) with time zone NOT NULL,
	"refreshed_at" timestamp (3) with time zone,
	CONSTRAINT "browser_sign_ins_workspace_id_domain_pk" PRIMARY KEY("workspace_id","domain"),
	CONSTRAINT "browser_sign_ins_state_check" CHECK ("browser_sign_ins"."state" IN ('signed_in', 'signed_out')),
	CONSTRAINT "browser_sign_ins_domain_check" CHECK ("browser_sign_ins"."domain" <> '')
);
--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "browser_released_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "waits_for_account" text;--> statement-breakpoint
ALTER TABLE "browser_sign_ins" ADD CONSTRAINT "browser_sign_ins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sign_ins_refresh_idx" ON "browser_sign_ins" USING btree ("state","checked_at");