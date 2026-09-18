CREATE TABLE "billing_accounts" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"paid_until" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"amount_rub" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"paid_until_after" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('created', 'pending', 'succeeded', 'canceled')),
	CONSTRAINT "payments_amount_rub_check" CHECK ("payments"."amount_rub" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"merchant" text NOT NULL,
	"merchant_order_id" text NOT NULL,
	"title" text NOT NULL,
	"price_rub" integer NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"pickup" text,
	"browser_run_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_merchant_order_uidx" UNIQUE("workspace_id","merchant","merchant_order_id"),
	CONSTRAINT "orders_merchant_check" CHECK ("orders"."merchant" IN ('wb', 'ozon', 'other')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('placed', 'cancelled', 'unknown')),
	CONSTRAINT "orders_price_rub_check" CHECK ("orders"."price_rub" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_pkey" PRIMARY KEY("workspace_id","kind","period_key"),
	CONSTRAINT "usage_counters_kind_check" CHECK ("usage_counters"."kind" IN ('messages', 'browser_runs', 'paywall_notices')),
	CONSTRAINT "usage_counters_period_key_check" CHECK ("usage_counters"."period_key" <> '')
);
--> statement-breakpoint
ALTER TABLE "browser_runs" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_workspace_idx" ON "payments" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "orders_workspace_idx" ON "orders" USING btree ("workspace_id","created_at" DESC NULLS FIRST);