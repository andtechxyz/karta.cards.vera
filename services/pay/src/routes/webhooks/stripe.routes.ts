import { Router, raw } from 'express';
import Stripe from 'stripe';
import { getPayConfig } from '../../env.js';

const router: Router = Router();

let stripeClient: Stripe | null = null;
function getClient(): Stripe {
  if (stripeClient) return stripeClient;
  const key = getPayConfig().STRIPE_SECRET_KEY ?? 'sk_test_unused';
  stripeClient = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  return stripeClient;
}

router.post('/stripe', raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const secret = getPayConfig().STRIPE_WEBHOOK_SECRET;
  const sig = req.header('stripe-signature');

  if (!secret) {
    // Reject unverified payloads — never process webhooks without signature verification.
    return res.status(501).json({ error: 'webhook_not_configured', message: 'STRIPE_WEBHOOK_SECRET is not set' });
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
