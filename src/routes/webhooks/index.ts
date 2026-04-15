import { Router } from 'express';
import stripeRouter from './stripe.routes.js';

// Mount point for /api/webhooks.  Each provider's webhook goes on its own
// path and owns its own body-parser config — Stripe wants raw bytes, Adyen
// wants HMAC-signed JSON, etc.  Keeps parsing decisions local to the route.
const webhooksRouter: Router = Router();

webhooksRouter.use(stripeRouter);

export default webhooksRouter;
