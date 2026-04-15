import crypto from 'node:crypto';
import { getConfig } from '../config.js';
import { hkdf } from './kdf.js';

// -----------------------------------------------------------------------------
// OBO ARQC — on-behalf-of application cryptogram.
//
// Key hierarchy (no per-card secrets stored anywhere):
//
//   VERA_ROOT_ARQC_SEED  (env, 32-byte hex root)
//     │
//     ▼  HKDF-SHA256(salt = "vera-vimk-v1", info = bin)
//   VIMK(bin)            (per-BIN issuer master key — re-derived on demand)
//     │
//     ▼  HKDF-SHA256(salt = "vera-card-ac", info = cardId || atc)
//   K_card               (per-transaction card session key — re-derived)
//     │
//     ▼  HMAC-SHA256 truncated to 16 bytes
//   ARQC = mac(K_card, amount || currency || merchantRef || nonce || atc)
//
// Card-scope domain separation uses the opaque `Card.id` cuid rather than the
// PICC UID (which the new schema only ever holds in ciphertext) or the PAN.
// Stable per-card, never crosses an HTTP boundary in cleartext, and keeps the
// orchestration off the PAN path: the provider adapter is the only code that
// decrypts the PAN, and ARQC derivation has no need for it.
//
// OBO: the real BIN-owning issuer has no part in this.  Vera is generating
// AND validating inside its own trust boundary.  The cryptogram is a
// self-consistent proof that we had the right derivation inputs.
// -----------------------------------------------------------------------------

const VIMK_SALT = Buffer.from('vera-vimk-v1');
const KCARD_SALT = Buffer.from('vera-card-ac');

// Cache the decoded seed across calls.  `getConfig()` is itself memoized but
// re-decoding from hex on every ARQC operation is pointless.
let seedBuffer: Buffer | null = null;
function getSeed(): Buffer {
  if (!seedBuffer) {
    seedBuffer = Buffer.from(getConfig().VERA_ROOT_ARQC_SEED, 'hex');
  }
  return seedBuffer;
}

export interface ArqcInput {
  /** 6-digit BIN (first 6 of PAN).  Plaintext on VaultEntry. */
  bin: string;
  /** Card.id (cuid) — opaque per-card scope for the KDF. */
  cardId: string;
  /** Application Transaction Counter. Must monotonically increase per card. */
  atc: number;
  amount: number;
  currency: string;
  merchantRef: string;
  /** Server-side random nonce bound to this transaction (Transaction.challengeNonce). */
  nonce: string;
}

export interface ArqcResult {
  arqc: string; // 16-byte hex
}

function deriveVimk(bin: string): Buffer {
  return hkdf(getSeed(), VIMK_SALT, Buffer.from(bin, 'utf8'), 32);
}

function deriveKCard(bin: string, cardId: string, atc: number): Buffer {
  const vimk = deriveVimk(bin);
  const atcBuf = Buffer.alloc(4);
  atcBuf.writeUInt32BE(atc, 0);
  const info = Buffer.concat([Buffer.from(cardId, 'utf8'), atcBuf]);
  return hkdf(vimk, KCARD_SALT, info, 32);
}

function buildMessage(i: ArqcInput): Buffer {
  const atcBuf = Buffer.alloc(4);
  atcBuf.writeUInt32BE(i.atc, 0);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64BE(BigInt(i.amount), 0);
  // Null-separated to prevent ambiguity between consecutive variable-length
  // fields.  Field order is fixed — any reordering changes the MAC.
  return Buffer.concat([
    amountBuf,
    Buffer.from([0]),
    Buffer.from(i.currency, 'utf8'),
    Buffer.from([0]),
    Buffer.from(i.merchantRef, 'utf8'),
    Buffer.from([0]),
    Buffer.from(i.nonce, 'utf8'),
    Buffer.from([0]),
    atcBuf,
  ]);
}

export function generateArqc(input: ArqcInput): ArqcResult {
  const kCard = deriveKCard(input.bin, input.cardId, input.atc);
  const msg = buildMessage(input);
  const mac = crypto.createHmac('sha256', kCard).update(msg).digest();
  return { arqc: mac.subarray(0, 16).toString('hex') };
}

/** Generate + symmetric compare, constant-time. */
export function validateArqc(input: ArqcInput, candidate: string): boolean {
  if (!/^[0-9a-fA-F]{32}$/.test(candidate)) return false;
  const expected = generateArqc(input).arqc;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(candidate.toLowerCase(), 'hex'),
    );
  } catch {
    return false;
  }
}
