// -----------------------------------------------------------------------------
// Payment provider adapter interface.
//
// The contract is minimal and deliberately provider-shape-neutral so that new
// providers (Adyen, Worldpay, ...) can be slotted in without changing
// TransactionService or any route.
//
// Each adapter is responsible for:
//   1. Consuming the retrieval token from the vault (via consumeRetrievalToken)
//      to receive the DecryptedCard **inside** its own trust boundary.
//   2. Calling the provider's tokenisation endpoint with that plaintext and
//      storing the provider's own reference.
//   3. Later, charging that reference with an idempotency key.
// -----------------------------------------------------------------------------

export interface PaymentProvider {
  readonly name: string;

  createPaymentMethod(input: {
    retrievalToken: string;
    expectedAmount: number;
    expectedCurrency: string;
    actor: string;
    transactionId?: string;
    cardholderNameOverride?: string;
  }): Promise<{ providerPaymentMethodId: string; last4: string }>;

  charge(input: {
    providerPaymentMethodId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    merchantRef: string;
  }): Promise<ChargeResult>;
}

export interface ChargeResult {
  providerTxnId: string;
  status: 'succeeded' | 'failed';
  error?: string;
}
