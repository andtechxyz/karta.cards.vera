-- Phase 3 Vera shrink.  Drops the card-domain tables + orphan enums from
-- Vera's Prisma schema, leaving only the vault / transaction / registration-
-- challenge / tokenisation-program domain that Vera actually owns after the
-- Vera/Palisade split.
--
-- Pay's last card-domain reads went to either Palisade HTTP (see
-- services/pay/src/cards/palisade-client.ts) or to denormalised fields on
-- Transaction (commits f79585c / ab9945b / 24519fe / 58e2a62 / ad71cfb).
--
-- CardOpSession was added to Vera's schema via migration
-- 20260419120000_add_card_op_sessions but only ever belonged to the card-
-- ops service which now lives on the Palisade side — drop it here as an
-- orphan of the Card table it referenced.
--
-- FinancialInstitution: Palisade now owns the canonical FI record; Vera's
-- copy has no live readers post-split.
--
-- Transaction.card relation (FK on Transaction.cardId → Card.id) is dropped;
-- cardId stays as a plain String — pay resolves card state via the Palisade
-- HTTP client now that the two tables live in different databases.

-- Drop the Transaction → Card FK first so Card can go.
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_cardId_fkey";

-- Drop tables that reference others first (children → parents), DROP TABLE
-- IF EXISTS + CASCADE for safety across environments that may have drifted.
DROP TABLE IF EXISTS "CardOpSession" CASCADE;
DROP TABLE IF EXISTS "ProvisioningSession" CASCADE;
DROP TABLE IF EXISTS "SadRecord" CASCADE;
DROP TABLE IF EXISTS "ActivationSession" CASCADE;
DROP TABLE IF EXISTS "WebAuthnCredential" CASCADE;
DROP TABLE IF EXISTS "MicrositeVersion" CASCADE;
DROP TABLE IF EXISTS "IssuerProfile" CASCADE;
DROP TABLE IF EXISTS "ChipProfile" CASCADE;
DROP TABLE IF EXISTS "EmbossingBatch" CASCADE;
DROP TABLE IF EXISTS "EmbossingTemplate" CASCADE;
DROP TABLE IF EXISTS "PartnerCredential" CASCADE;
DROP TABLE IF EXISTS "Card" CASCADE;
DROP TABLE IF EXISTS "Program" CASCADE;
DROP TABLE IF EXISTS "FinancialInstitution" CASCADE;

-- Drop enums that only the above tables referenced.
DROP TYPE IF EXISTS "CardStatus";
DROP TYPE IF EXISTS "ActivationMethod";
