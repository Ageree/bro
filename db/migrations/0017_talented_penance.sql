CREATE TABLE "onboarding_requests" (
	"phone_number" text PRIMARY KEY NOT NULL,
	"assigned_phone_number" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "onboarding_requests_caller_idx" ON "onboarding_requests" USING btree ("ip_hash","created_at");