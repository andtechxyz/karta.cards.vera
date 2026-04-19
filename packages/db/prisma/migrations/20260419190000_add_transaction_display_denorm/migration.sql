-- Denormalise Palisade-owned card display fields + the local VaultEntry
-- pointer onto Transaction.  Pay used to JOIN Transaction → Card (→ VaultEntry)
-- for every list/detail read; after the Vera/Palisade split Card lives in
-- Palisade's DB, so the old join would require a cross-repo fan-out on the
-- hot path.  Instead we stamp the display subset at Transaction create time
-- (from the lookupCard response that pay already makes to validate the card)
-- and read it directly from the row afterwards.
--
-- All columns are nullable — existing rows carry NULLs, and in dev we do
-- not backfill.  vaultEntryId is a loose reference (no FK) because pay's
-- createTransaction path may run before the VaultEntry linkage exists for
-- admin-only test cards.  post-auth continues to validate the VaultEntry
-- row exists before attempting a retrieval-token mint.

ALTER TABLE "Transaction" ADD COLUMN "cardRef"        TEXT;
ALTER TABLE "Transaction" ADD COLUMN "panLast4"       TEXT;
ALTER TABLE "Transaction" ADD COLUMN "panBin"         TEXT;
ALTER TABLE "Transaction" ADD COLUMN "cardholderName" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "vaultEntryId"   TEXT;
