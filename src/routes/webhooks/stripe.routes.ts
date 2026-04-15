import { Router, raw } from 'express';
import Stripe from 'stripe';
import { getConfig } from '../../config.js';

const router: Router = Router();

// -----------------------------------------------------------------------------
// Stripe webhook stub.
//
// For the prototype this is observational only — the happy path confirms
// synchronously in orchestratePostAuth, so webhook events don't drive state.
// We still verify the signature (if a secret is configured) so we can log
// a correctly-authenticated event, and fail-closed if a secret is set but
// the signature is bad.
//
// Mounted with `express.raw()` in src/index.ts so we never hand this router
// a JSON-parsed body.  Stripe's signature is computed over the exact bytes.
// -----------------------------------------------------------------------------

// Lazily-initialised Stripe client.  We only need one for `webhooks.constructEvent`,
// which doesn't actually call the API — but the SDK still wants a key to be
// instantiated.  Cached so we don't rebuild it per-request.
let stripeClient: Stripe | null = null;
function getClient(): Stripe {
  if (stripeClient) return stripeClient;
  const key = getConfig().STRIPE_SECRET_KEY ?? 'sk_test_unused';
  stripeClient = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  return stripeClient;
}

router.post('/stripe', raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const secret = getConfig().STRIPE_WEBHOOK_SECRET;
  const sig = req.header('stripe-signature');

  if (!secret) {
    // No secret configured — accept the payload unchecked but record it, so
    // early development isn't blocked by webhook wiring.
    // eslint-disable-next-line no-console
    console.log('[stripe-webhook] received (unverified — no STRIPE_WEBHOOK_SECRET set)');
    return res.status(202).json({ received: true, verified: false });
  }

  if (!sig) {
    return res.status(400).json({ error: 'missing_signature' });
  }

  try {
    const event = getClient().webhooks.constructEvent(req.body as Buffer, sig, secret);
    // eslint-disable-next-line no-console
    console.log(`[stripe-webhook] ${event.type}  ${event.id}`);
    return res.status(200).json({ received: true, verified: true, type: event.type });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: 'bad_signature', message: msg });
  }
});

export default router;
