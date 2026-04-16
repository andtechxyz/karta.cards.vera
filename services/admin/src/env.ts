import { defineEnv, baseEnvShape, hexKey, originList } from '@vera/core';
import { z } from 'zod';

// Admin service handles program CRUD, card admin, and is the HMAC-signed
// gateway the admin browser uses to reach the vault.  It does NOT decrypt
// PANs itself — vault owns that.
const { get: getAdminConfig, reset: _resetAdminConfig } = defineEnv({
  ...baseEnvShape,
  CORS_ORIGINS: originList,
  PORT: z.coerce.number().int().positive().default(3005),
  WEBAUTHN_ORIGIN: z.string().url().default('https://admin.karta.cards'),
  // Browser-facing admin auth.  32-byte hex sent as X-Admin-Key header on every
  // admin API call.  Compared in constant time against this value; no roles,
  // no rotation, no sessions — minimum defensible auth for the prototype.
  ADMIN_API_KEY: hexKey(32),
  // Vault leg — admin backend signs outbound vault calls as keyId='admin'.
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  SERVICE_AUTH_ADMIN_SECRET: hexKey(32),
});

export { getAdminConfig, _resetAdminConfig };
