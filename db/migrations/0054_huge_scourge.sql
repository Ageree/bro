CREATE TABLE "mail_authorizations" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"access" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mail_authorizations_provider_check" CHECK ("mail_authorizations"."provider" IN ('mailru', 'yandex')),
	CONSTRAINT "mail_authorizations_access_check" CHECK ("mail_authorizations"."access" IN ('full', 'read_only'))
);
--> statement-breakpoint
CREATE TABLE "mail_connections" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"access" text NOT NULL,
	"email" text NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_connections_workspace_id_provider_pk" PRIMARY KEY("workspace_id","provider"),
	CONSTRAINT "mail_connections_provider_check" CHECK ("mail_connections"."provider" IN ('mailru', 'yandex')),
	CONSTRAINT "mail_connections_access_check" CHECK ("mail_connections"."access" IN ('full', 'read_only'))
);
--> statement-breakpoint
CREATE TABLE "mail_sends" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"operation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sends_workspace_id_provider_operation_id_pk" PRIMARY KEY("workspace_id","provider","operation_id"),
	CONSTRAINT "mail_sends_provider_check" CHECK ("mail_sends"."provider" IN ('mailru', 'yandex')),
	CONSTRAINT "mail_sends_status_check" CHECK ("mail_sends"."status" IN ('sending', 'accepted', 'uncertain'))
);
--> statement-breakpoint
ALTER TABLE "mail_authorizations" ADD CONSTRAINT "mail_authorizations_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_workspace_id_user_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;