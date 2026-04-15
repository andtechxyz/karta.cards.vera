import { defineEnv, baseEnvShape, hexKey } from '@vera/core';
import { z } from 'zod';

const { get: getPayConfig, reset: _resetPayConfig } = defineEnv({
  ...baseEnvShape,
  PORT: z.coerce.number().int().positive().default(3003),
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  VERA_ROOT_ARQC_SEED: hexKey(32),
});

export { getPayConfig, _resetPayConfig };
