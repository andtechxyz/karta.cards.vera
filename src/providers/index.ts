import { getConfig } from '../config.js';
import { MockProvider } from './mock.provider.js';
import { StripeProvider } from './stripe.provider.js';
import type { PaymentProvider } from './provider.interface.js';

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const name = getConfig().PAYMENT_PROVIDER;
  switch (name) {
    case 'stripe':
      cached = new StripeProvider();
      break;
    case 'mock':
      cached = new MockProvider();
      break;
  }
  return cached;
}

export function _setPaymentProvider(p: PaymentProvider | null): void {
  cached = p;
}

export type { PaymentProvider, ChargeResult } from './provider.interface.js';
