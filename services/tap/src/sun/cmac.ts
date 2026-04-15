import { createCipheriv } from 'node:crypto';

// AES-128-CMAC per NIST SP 800-38B.
//
// Hand-rolled on top of node:crypto's AES-128-ECB single-block primitive
// because Node has no first-class CMAC API and the npm `aes-cmac` package is
// long-stagnant.  Matches the Python reference (palisade-sun) byte-for-byte
// against NIST SP 800-38B Appendix D test vectors.

const BLOCK_SIZE = 16;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);
const RB = 0x87; // GF(2^128) reduction polynomial constant for 128-bit blocks

function aesEcbEncryptBlock(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  // Buffer.concat's typing returns Buffer<ArrayBufferLike>; copy into a fresh
  // Buffer so the return narrows to Buffer<ArrayBuffer> (matches our K1/K2
  // accumulator types and avoids cascading inference noise).
  return Buffer.from(Buffer.concat([cipher.update(block), cipher.final()]));
}

/** Left-shift a buffer by one bit; carry-out is discarded. */
function leftShiftOneBit(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  let carry = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const v = (input[i] << 1) | carry;
    out[i] = v & 0xff;
    carry = (v >> 8) & 1;
  }
  return out;
}

function deriveSubkeys(key: Buffer): { K1: Buffer; K2: Buffer } {
  const L = aesEcbEncryptBlock(key, ZERO_BLOCK);
  const K1 = leftShiftOneBit(L);
  if (L[0] & 0x80) K1[BLOCK_SIZE - 1] ^= RB;
  const K2 = leftShiftOneBit(K1);
  if (K1[0] & 0x80) K2[BLOCK_SIZE - 1] ^= RB;
  return { K1, K2 };
}

function xorInto(dst: Buffer, src: Buffer): void {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

export function aesCmac(key: Buffer, data: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error('AES-128-CMAC requires a 16-byte key');
  }

  const { K1, K2 } = deriveSubkeys(key);

  const blockCount = Math.max(1, Math.ceil(data.length / BLOCK_SIZE));
  const lastBlockComplete = data.length > 0 && data.length % BLOCK_SIZE === 0;

  // Build the (XOR-prepared) last block.
  const lastBlock = Buffer.alloc(BLOCK_SIZE);
  if (lastBlockComplete) {
    data.copy(lastBlock, 0, (blockCount - 1) * BLOCK_SIZE, blockCount * BLOCK_SIZE);
    xorInto(lastBlock, K1);
  } else {
    const remainder = data.length - (blockCount - 1) * BLOCK_SIZE;
    if (remainder > 0) {
      data.copy(lastBlock, 0, (blockCount - 1) * BLOCK_SIZE, data.length);
    }
    lastBlock[remainder] = 0x80; // mandatory padding bit
    xorInto(lastBlock, K2);
  }

  // CBC-MAC chain over the leading blocks, ending with the prepared last block.
  // `x` is annotated explicitly so it doesn't narrow to `Buffer<ArrayBuffer>`
  // off ZERO_BLOCK and then refuse the AES-EBC return type.
  let x: Buffer = ZERO_BLOCK;
  const xored = Buffer.alloc(BLOCK_SIZE);
  for (let i = 0; i < blockCount - 1; i++) {
    const block = data.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
    for (let j = 0; j < BLOCK_SIZE; j++) xored[j] = x[j] ^ block[j];
    x = aesEcbEncryptBlock(key, xored);
  }
  for (let j = 0; j < BLOCK_SIZE; j++) xored[j] = x[j] ^ lastBlock[j];
  return aesEcbEncryptBlock(key, xored);
}
