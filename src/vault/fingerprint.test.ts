import { describe, it, expect } from 'vitest';
import { fingerprintPan, luhnValid } from './fingerprint.js';

describe('luhnValid', () => {
  it('accepts the canonical Stripe test PAN', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
  });

  it('rejects a one-digit corruption of the same PAN', () => {
    expect(luhnValid('4242424242424241')).toBe(false);
  });

  it('tolerates whitespace and dashes', () => {
    expect(luhnValid('4242 4242-4242 4242')).toBe(true);
  });

  it('rejects non-digits', () => {
    expect(luhnValid('4242424242abc242')).toBe(false);
  });

  it('rejects too-short and too-long inputs', () => {
    expect(luhnValid('4242')).toBe(false);
    expect(luhnValid('4'.repeat(20))).toBe(false);
  });
});

describe('fingerprintPan', () => {
  it('is deterministic for the same PAN', () => {
    const a = fingerprintPan('4242424242424242');
    const b = fingerprintPan('4242424242424242');
    expect(a).toBe(b);
  });

  it('normalises spaces and dashes — same fingerprint as the bare digits', () => {
    expect(fingerprintPan('4242 4242 4242 4242')).toBe(fingerprintPan('4242424242424242'));
    expect(fingerprintPan('4242-4242-4242-4242')).toBe(fingerprintPan('4242424242424242'));
  });

  it('produces different fingerprints for different PANs', () => {
    expect(fingerprintPan('4242424242424242')).not.toBe(fingerprintPan('4111111111111111'));
  });

  it('returns 64 hex chars (SHA-256)', () => {
    expect(fingerprintPan('4242424242424242')).toMatch(/^[0-9a-f]{64}$/);
  });
});
