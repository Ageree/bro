CREATE TABLE "memory_documents" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_documents_version_check" CHECK ("memory_documents"."version" > 0)
);
