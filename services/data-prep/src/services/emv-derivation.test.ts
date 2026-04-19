import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmvDerivationService } from './emv-derivation.js';
import type { UdkDeriver } from './udk-deriver.js';

// EmvDerivationService is a thin orchestrator over UdkDeriver.  The per-
// backend crypto is exercised in udk-deriver.test.ts; here we only verify
// the fan-out (one deriveIcvv + three deriveMasterKey calls) and that the
// returned DerivedKeys shape carries every per-MK field.

function makeStubDeriver(): {
  deriver: UdkDeriver;
  icvv: ReturnType<typeof vi.fn>;
  mk: ReturnType<typeof vi.fn>;
} {
  const icvv = vi.fn().mockResolvedValue('789');
  const mk = vi.fn().mockImplementation(async (imkArn: string) => ({
    keyArn: `derived:stub:${imkArn}`,
    kcv: 'ABCDEF',
    keyBytes: Buffer.from(imkArn).subarray(0, 16),
  }));
  return { deriver: { deriveIcvv: icvv, deriveMasterKey: mk }, icvv, mk };
}

describe('EmvDerivationService', () => {
  describe('deriveAllKeys', () => {
    it('fans out one iCVV + three MK derivations, one per (AC, SMI, SMC) IMK', async () => {
      const { deriver, icvv, mk } = makeStubDeriver();
      const svc = new EmvDerivationService(deriver);

      const keys = await svc.deriveAllKeys(
        'arn:tmk',
        'arn:imk-ac',
        'arn:imk-smi',
        'arn:imk-smc',
        '4242424242424242',
        '2812',
        '01',
      );

      expect(icvv).toHaveBeenCalledOnce();
      expect(icvv).toHaveBeenCalledWith('arn:tmk', '4242424242424242', '2812');
      expect(mk).toHaveBeenCalledTimes(3);
      expect(mk.mock.calls.map((c) => c[0])).toEqual([
        'arn:imk-ac',
        'arn:imk-smi',
        'arn:imk-smc',
      ]);
      expect(keys.icvv).toBe('789');
      expect(keys.mkAcArn).toBe('derived:stub:arn:imk-ac');
      expect(keys.mkSmiArn).toBe('derived:stub:arn:imk-smi');
      expect(keys.mkSmcArn).toBe('derived:stub:arn:imk-smc');
      expect(keys.mkAcKcv).toBe('ABCDEF');
    });

    it('surfaces UdkDeriver errors (Promise.all rejects on first failure)', async () => {
      const deriver: UdkDeriver = {
        deriveIcvv: vi.fn().mockResolvedValue('000'),
        deriveMasterKey: vi.fn().mockRejectedValue(new Error('HSM unavailable')),
      };
      const svc = new EmvDerivationService(deriver);
      await expect(
        svc.deriveAllKeys('t', 'a', 's', 'c', '4242424242424242', '2812', '01'),
      ).rejects.toThrow(/HSM unavailable/);
    });
  });

  describe('fromBackend', () => {
    it('constructs a service backed by MockUdkDeriver for backend=mock', async () => {
      const svc = EmvDerivationService.fromBackend('mock');
      const icvv = await svc.deriveIcvv('t', '4242424242424242', '2812');
      expect(icvv).toMatch(/^\d{3}$/);
    });

    it('rejects backend=local without a seed', () => {
      expect(() => EmvDerivationService.fromBackend('local')).toThrow(
        /requires localRootSeedHex/,
      );
    });
  });

  describe('fromEnv', () => {
    beforeEach(() => vi.resetModules());

    it('uses the backend configured in DATA_PREP_UDK_BACKEND', async () => {
      // Default env in tests/setup.ts is DATA_PREP_UDK_BACKEND=mock, so
      // fromEnv() picks MockUdkDeriver and iCVV is sha256-based.
      const svc = EmvDerivationService.fromEnv();
      const icvv = await svc.deriveIcvv('arn:tmk', '4242424242424242', '2812');
      expect(icvv).toMatch(/^\d{3}$/);
    });
  });
});
