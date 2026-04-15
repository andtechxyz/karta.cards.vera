import Stripe from 'stripe';
import { getPayConfig } from '../env.js';
import type { VaultClient } from '@vera/vault-client';
import type { ChargeResult, PaymentProvider } from './provider.interface.js';

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private client: Stripe | null = null;

  constructor(private readonly vaultClient: VaultClient) {}

  private getClient(): Stripe {
    if (this.client) return this.client;
    const key = getPayConfig().STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        'PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — fix .env and restart',
      );
    }
    this.client = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
    return this.client;
  }

  async createPaymentMethod(input: {
    retrievalToken: string;
    expectedAmount: number;
    expectedCurrency: string;
    actor: string;
    transactionId?: string;
    cardholderNameOverride?: string;
  }) {
    const consumed = await this.vaultClient.consumeToken({
      token: input.retrievalToken,
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      actor: input.actor,
      purpose: 'stripe.createPaymentMethod',
      transactionId: input.transactionId,
    });

    const pm = await this.getClient().paymentMethods.create({
      type: 'card',
      card: {
        number: consumed.card.pan,
        exp_month: parseInt(consumed.card.expMonth, 10),
        exp_year: 2000 + parseInt(consumed.card.expYear, 10),
        cvc: consumed.card.cvc,
      },
      billing_details: {
        name: input.cardholderNameOverride ?? consumed.card.cardholderName ?? undefined,
      },
    });

    return {
      providerPaymentMethodId: pm.id,
      last4: pm.card?.last4 ?? consumed.card.last4,
    };
  }

  async charge(input: {
    providerPaymentMethodId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    merchantRef: string;
  }): Promise<ChargeResult> {
    try {
      const pi = await this.getClient().paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency.toLowerCase(),
          payment_method: input.providerPaymentMethodId,
          confirm: true,
          off_session: false,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { merchantRef: input.merchantRef },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (pi.status === 'succeeded') {
        return { providerTxnId: pi.id, status: 'succeeded' };
      }
      return { providerTxnId: pi.id, status: 'failed', error: `paymentIntent status: ${pi.status}` };
    } catch (err) {
      return { providerTxnId: '', status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
