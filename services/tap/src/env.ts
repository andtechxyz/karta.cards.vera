import { defineEnv, baseEnvShape, cardFieldCryptoEnvShape } from '@vera/core';
import { z } from 'zod';

const { get: getTapConfig, reset: _resetTapConfig } = defineEnv({
  ...baseEnvShape,
  ...cardFieldCryptoEnvShape,
  PORT: z.coerce.number().int().positive().default(3001),
  TAP_HANDOFF_SECRET: z.string().min(32),
  ACTIVATION_URL: z.string().url(),
  MOBILE_APP_URL: z.string().url().default('https://app.karta.cards'),
});

export { getTapConfig, _resetTapConfig };
