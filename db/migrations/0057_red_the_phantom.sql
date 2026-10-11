CREATE TABLE "yandex_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"service" text NOT NULL,
	"checkout_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'quoted' NOT NULL,
	"confirmation_question" text NOT NULL,
	"public_quote" jsonb NOT NULL,
	"provider_snapshot" jsonb NOT NULL,
	"outcome" jsonb,
	"merchant_order_id" text,
	"call_id" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp (3) with time zone,
	"settled_at" timestamp (3) with time zone,
	CONSTRAINT "yandex_purchases_fingerprint_uidx" UNIQUE("workspace_id","service","fingerprint"),
	CONSTRAINT "yandex_purchases_service_check" CHECK ("yandex_purchases"."service" = 'lavka'),
	CONSTRAINT "yandex_purchases_currency_check" CHECK ("yandex_purchases"."currency" = 'RUB'),
	CONSTRAINT "yandex_purchases_amount_check" CHECK ("yandex_purchases"."amount_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "yandex_purchases_state_check" CHECK ("yandex_purchases"."state" IN ('quoted', 'submitting', 'placed', 'rejected', 'unknown')),
	CONSTRAINT "yandex_purchases_attempt_check" CHECK (("yandex_purchases"."state" = 'quoted' AND "yandex_purchases"."call_id" IS NULL AND "yandex_purchases"."submitted_at" IS NULL) OR ("yandex_purchases"."state" <> 'quoted' AND "yandex_purchases"."call_id" IS NOT NULL AND "yandex_purchases"."submitted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "yandex_purchases" ADD CONSTRAINT "yandex_purchases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "yandex_purchases_active_uidx" ON "yandex_purchases" USING btree ("workspace_id","service") WHERE "yandex_purchases"."state" IN ('submitting', 'unknown');