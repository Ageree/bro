-- Idempotent: a second run leaves the column an earlier run added as it is.
-- Orders recorded before this keep null: their lines were never kept.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "items" jsonb;