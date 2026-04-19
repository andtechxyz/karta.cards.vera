-- Adds VaultEntry.idempotencyKey for the cross-service register path.
--
-- Palisade calls POST /api/vault/register with a caller-supplied idempotencyKey
-- at card-issue time.  A retry with the same key returns the same vaultToken
-- without creating a duplicate entry.  Nullable because the internal admin
-- /store path doesn't use it; unique so collisions between distinct callers
-- surface as an error rather than silently overwriting.

ALTER TABLE "VaultEntry" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "VaultEntry_idempotencyKey_key"
  ON "VaultEntry" ("idempotencyKey");
