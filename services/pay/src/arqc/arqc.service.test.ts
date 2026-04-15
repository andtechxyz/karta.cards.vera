import { describe, it, expect } from 'vitest';
import { generateArqc, validateArqc, type ArqcInput } from './arqc.service.js';

const BASE: ArqcInput = {
  bin: '424242',
  cardId: 'card_AAAAAAAAAAAAAAAAAA',
  atc: 1,
  amount: 5000,
  currency: 'USD',
  merchantRef: 'order_42',
  nonce: 'n0_random_challenge',
};

describe('ARQC generate/validate symmetry', () => {
  it('validates an ARQC it just generated', () => {
    const { arqc } = generateArqc(BASE);
    expect(validateArqc(BASE, arqc)).toBe(true);
  });

  it('is deterministic — same inputs yield the same ARQC', () => {
    expect(generateArqc(BASE).arqc).toBe(generateArqc(BASE).arqc);
  });

  it('returns 16 bytes (32 hex chars)', () => {
    expect(generateArqc(BASE).arqc).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ARQC asymmetry — any input mutation invalidates the MAC', () => {
  const base = generateArqc(BASE).arqc;

  it('rejects a different amount', () => {
    expect(validateArqc({ ...BASE, amount: 5001 }, base)).toBe(false);
  });

  it('rejects a different ATC', () => {
    expect(validateArqc({ ...BASE, atc: 2 }, base)).toBe(false);
  });

  it('rejects a different cardId — same BIN cards do not collide', () => {
    expect(validateArqc({ ...BASE, cardId: 'card_BBBBBBBBBBBBBBBBBB' }, base)).toBe(false);
  });

  it('rejects a different BIN', () => {
    expect(validateArqc({ ...BASE, bin: '411111' }, base)).toBe(false);
  });

  it('rejects a different currency', () => {
    expect(validateArqc({ ...BASE, currency: 'EUR' }, base)).toBe(false);
  });

  it('rejects a different merchantRef', () => {
    expect(validateArqc({ ...BASE, merchantRef: 'order_43' }, base)).toBe(false);
  });

  it('rejects a different nonce', () => {
    expect(validateArqc({ ...BASE, nonce: 'n1_something_else' }, base)).toBe(false);
  });
});

describe('ARQC malformed candidate handling', () => {
  it('rejects a non-hex candidate', () => {
    expect(validateArqc(BASE, 'not-hex')).toBe(false);
  });

  it('rejects a wrong-length candidate (too short)', () => {
    expect(validateArqc(BASE, 'aabbcc')).toBe(false);
  });

  it('rejects a wrong-length candidate (too long)', () => {
    expect(validateArqc(BASE, 'a'.repeat(64))).toBe(false);
  });

  it('is case-insensitive on the candidate hex', () => {
    const { arqc } = generateArqc(BASE);
    expect(validateArqc(BASE, arqc.toUpperCase())).toBe(true);
  });
});
