import { prisma } from '@vera/db';
import { decrypt, type KeyProvider } from '@vera/core';
import { decryptPiccData } from './picc.js';

// Trial-decrypt PICC data against every Card in a given program until one
// matches.  The "match" signal is the SDM tag byte (0xC7) showing up at
// plaintext offset 0 — every other key produces effectively-random bytes
// there with probability 1/256.
//
// Phase 1 of the cardRef-less SUN URL design.  Acceptable while program
// fleet is small (10s–100s of cards): N candidates × ~1ms decrypt each.
//
// Phase 2 swaps this for HSM-derived per-card keys (UDK pattern) so the
// per-card-key resolution is deterministic + O(1) regardless of fleet size.
//
// We deliberately filter to ACTIVATED + PROVISIONED only — SHIPPED cards
// have no business hitting this endpoint (their NDEF URL still points at
// the activation flow, not at /t/<urlCode>), and SUSPENDED/REVOKED cards
// must be rejected upstream of any signed-handoff mint.

export interface FindCardByPiccInput {
  /**
   * Optional program scope.  When set, only Cards in this program are tried
   * (Phase-1 url-coded shape).  When omitted, every ACTIVATED+PROVISIONED
   * Card across the entire fleet is tried — used by the mobile-app's
   * cardRef-less tap-verify endpoint where the URL doesn't carry a
   * discriminator.  O(N) across the whole fleet; acceptable while N is
   * small (~10s of cards).  Phase 2 (UDK derivation) makes this O(1).
   */
  programId?: string;
  piccHex: string;
  /** Card-field DEK provider — used to decrypt the per-card SDM keys. */
  keyProvider: KeyProvider;
}

export interface FindCardByPiccMatch {
  cardId: string;
  cardStatus: string;
  lastReadCounter: number;
  /** AES-128 key, plaintext.  Caller MUST scrub when done. */
  sdmMetaReadKey: Buffer;
  /** AES-128 key, plaintext.  Caller MUST scrub when done. */
  sdmFileReadKey: Buffer;
  /** PICC plaintext fields (UID, counter, etc) — already decrypted, save redoing. */
  uid: Buffer;
  counter: number;
}

/**
 * Returns the matching Card + already-decrypted PICC, or null if no card
 * in the program decrypted the PICC bytes to a valid (tag=0xC7) plaintext.
 */
export async function findCardByPicc(
  input: FindCardByPiccInput,
): Promise<FindCardByPiccMatch | null> {
  const candidates = await prisma.card.findMany({
    where: {
      ...(input.programId ? { programId: input.programId } : {}),
      status: { in: ['ACTIVATED', 'PROVISIONED'] },
    },
    select: {
      id: true,
      status: true,
      lastReadCounter: true,
      keyVersion: true,
      sdmMetaReadKeyEncrypted: true,
      sdmFileReadKeyEncrypted: true,
    },
  });

  for (const c of candidates) {
    let metaKey: Buffer | null = null;
    try {
      const metaHex = decrypt(
        { ciphertext: c.sdmMetaReadKeyEncrypted, keyVersion: c.keyVersion },
        input.keyProvider,
      );
      metaKey = Buffer.from(metaHex, 'hex');
      const picc = decryptPiccData(metaKey, input.piccHex);
      if (!picc.valid) {
        // Tag mismatch — wrong key, try the next candidate.
        metaKey.fill(0);
        continue;
      }

      // Match — decrypt the file-read key too and return.  Caller scrubs both.
      const fileHex = decrypt(
        { ciphertext: c.sdmFileReadKeyEncrypted, keyVersion: c.keyVersion },
        input.keyProvider,
      );
      const sdmFileReadKey = Buffer.from(fileHex, 'hex');

      return {
        cardId: c.id,
        cardStatus: c.status,
        lastReadCounter: c.lastReadCounter,
        sdmMetaReadKey: metaKey,
        sdmFileReadKey,
        uid: picc.uid,
        counter: picc.counter,
      };
    } catch {
      // GCM auth fail or any other decrypt error = wrong key, try next.
      metaKey?.fill(0);
      continue;
    }
  }

  return null;
}
