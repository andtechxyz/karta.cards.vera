import { defineEnv, baseEnvShape, cardFieldCryptoEnvShape, hexKey } from '@vera/core';
import { z } from 'zod';

const { get: getActivationConfig, reset: _resetActivationConfig } = defineEnv({
  ...baseEnvShape,
  ...cardFieldCryptoEnvShape,
  // Activation is the only service that fingerprints UIDs (for collision
  // detection at register time).  Declared inline — no shared fragment.
  CARD_UID_FINGERPRINT_KEY: hexKey(32),
  PORT: z.coerce.number().int().positive().default(3002),
  TAP_HANDOFF_SECRET: z.string().min(32),
  PAY_URL: z.string().url().default('https://pay.karta.cards'),
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
});

export { getActivationConfig, _resetActivationConfig };
