import { createVaultClient } from '@vera/vault-client';
import { getPayConfig } from '../env.js';
import { MockProvider } from './mock.provider.js';
import { StripeProvider } from './stripe.provider.js';
import type { PaymentProvider } from './provider.interface.js';

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const config = getPayConfig();
  const vaultClient = createVaultClient(config.VAULT_SERVICE_URL, {
    keyId: 'pay',
    secret: config.SERVICE_AUTH_PAY_SECRET,
  });
  switch (config.PAYMENT_PROVIDER) {
    case 'stripe':
      cached = new StripeProvider(vaultClient);
      break;
    case 'mock':
      cached = new MockProvider(vaultClient);
      break;
  }
  return cached;
}

export type { PaymentProvider, ChargeResult } from './provider.interface.js';
