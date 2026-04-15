import Stripe from 'stripe';
import { getConfig } from '../config.js';
import { consumeRetrievalToken, vaultEvents } from '../vault/index.js';
import type { ChargeResult, PaymentProvider } from './provider.interface.js';

/**
 * Stripe adapter.  Uses the `stripe` SDK in test mode.
 *
 * Key guarantees:
 *   - PAN only exists inside createPaymentMethod, briefly, and only within
 *     this module's trust boundary.
 *   - charge() forwards the caller's idempotency key to Stripe via the
 *     `idempotencyKey` request option, preventing double-charges on retry.
 *
 * The SDK is instantiated lazily so the server can boot without STRIPE_*
 * keys; the error only surfaces when PAYMENT_PROVIDER=stripe tries to tokenise.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private client: Stripe | null = null;

  private getClient(): Stripe {
    if (this.client) return this.client;
    const key = getConfig().STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        'PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — fix .env and restart',
      );
    }
    this.client = new Stripe(key, { apiVersion: '2024-12-18.acacia' });
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
    const consumed = await consumeRetrievalToken(input.retrievalToken, {
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      actor: input.actor,
      purpose: 'stripe.createPaymentMethod',
      transactionId: input.transactionId,
    });

    try {
      const pm = await this.getClient().paymentMethods.create({
        type: 'card',
        card: {
          number: consumed.card.pan,
          exp_month: parseInt(consumed.card.expMonth, 10),
          exp_year: 2000 + parseInt(consumed.card.expYear, 10),
          cvc: consumed.card.cvc,
        },
        billing_details: {
          name: input.cardholderNameOverride ?? consumed.card.cardholderName,
        },
      });

      vaultEvents.emit({
        type: 'PROVIDER_TOKENISED',
        vaultEntryId: consumed.vaultEntryId,
        retrievalTokenId: consumed.retrievalTokenId,
        providerName: this.name,
        transactionId: input.transactionId,
        actor: input.actor,
        purpose: 'stripe.createPaymentMethod',
        success: true,
      });

      return {
        providerPaymentMethodId: pm.id,
        last4: pm.card?.last4 ?? consumed.card.last4,
      };
    } catch (err) {
      vaultEvents.emit({
        type: 'PROVIDER_TOKENISED',
        vaultEntryId: consumed.vaultEntryId,
        retrievalTokenId: consumed.retrievalTokenId,
        providerName: this.name,
        transactionId: input.transactionId,
        actor: input.actor,
        purpose: 'stripe.createPaymentMethod',
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
      return {
        providerTxnId: pi.id,
        status: 'failed',
        error: `paymentIntent status: ${pi.status}`,
      };
    } catch (err) {
      return {
        providerTxnId: '',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
