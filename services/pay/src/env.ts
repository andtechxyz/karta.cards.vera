import { defineEnv, baseEnvShape, hexKey, originList } from '@vera/core';
import { z } from 'zod';

const { get: getPayConfig, reset: _resetPayConfig } = defineEnv({
  ...baseEnvShape,
  CORS_ORIGINS: originList,
  PORT: z.coerce.number().int().positive().default(3003),
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  // Shared secret for HMAC-signed vault calls; must appear verbatim in the
  // vault service's SERVICE_AUTH_KEYS['pay'].
  SERVICE_AUTH_PAY_SECRET: hexKey(32),
  PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Admin API key — gates registration endpoints that should only be called
  // from the admin surface, not by arbitrary cardholders.
  ADMIN_API_KEY: hexKey(32),
  TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  VERA_ROOT_ARQC_SEED: hexKey(32),
});

export { getPayConfig, _resetPayConfig };
