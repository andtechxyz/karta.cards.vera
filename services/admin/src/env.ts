import { defineEnv, baseEnvShape } from '@vera/core';
import { z } from 'zod';

// Admin service handles program CRUD and card admin.
// It does NOT decrypt PANs (no cryptoEnvShape) — vault owns that.
const { get: getAdminConfig, reset: _resetAdminConfig } = defineEnv({
  ...baseEnvShape,
  PORT: z.coerce.number().int().positive().default(3005),
  // Origins for admin UI
  WEBAUTHN_ORIGIN: z.string().url().default('https://admin.karta.cards'),
});

export { getAdminConfig, _resetAdminConfig };
