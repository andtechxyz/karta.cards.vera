import { defineEnv, baseEnvShape, cryptoEnvShape } from '@vera/core';
import { z } from 'zod';

const { get: getActivationConfig, reset: _resetActivationConfig } = defineEnv({
  ...baseEnvShape,
  ...cryptoEnvShape,
  PORT: z.coerce.number().int().positive().default(3002),
  TAP_HANDOFF_SECRET: z.string().min(32),
  PAY_URL: z.string().url().default('https://pay.karta.cards'),
});

export { getActivationConfig, _resetActivationConfig };
