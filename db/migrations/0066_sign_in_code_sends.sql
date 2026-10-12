CREATE TABLE "sign_in_code_sends" (
	"key" text NOT NULL,
	"sent_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sign_in_code_sends_key_idx" ON "sign_in_code_sends" USING btree ("key","sent_at");