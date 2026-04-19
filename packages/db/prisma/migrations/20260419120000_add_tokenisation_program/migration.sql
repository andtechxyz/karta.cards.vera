-- Phase 4c — TokenisationProgram is Vera's authoritative source for tier
-- limits.  Palisade's Program keeps the card-domain fields (NDEF URLs, FI
-- relation, embossing template) but loses tierRules in a follow-up migration
-- on the Palisade side.  Pay service reads from TokenisationProgram by
-- card.programId to enforce per-tier credential requirements at tx time.
--
-- No FKs cross into Palisade's DB.  The `id` matches Palisade Program.id by
-- convention; seeding/admin writes populate both sides.

CREATE TABLE "TokenisationProgram" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "currency"  VARCHAR(3) NOT NULL,
    "tierRules" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenisationProgram_pkey" PRIMARY KEY ("id")
);
