import { defineEnv, baseEnvShape, hexKey, originList } from '@vera/core';
import { z } from 'zod';

// Admin service handles program CRUD, card admin, and is the HMAC-signed
// gateway the admin browser uses to reach the vault.  It does NOT decrypt
// PANs itself — vault owns that.
const { get: getAdminConfig, reset: _resetAdminConfig } = defineEnv({
  ...baseEnvShape,
  CORS_ORIGINS: originList,
  PORT: z.coerce.number().int().positive().default(3005),
  WEBAUTHN_ORIGIN: z.string().url().default('https://manage.karta.cards'),
  // Vault leg — admin backend signs outbound vault calls as keyId='admin'.
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  SERVICE_AUTH_ADMIN_SECRET: hexKey(32),
  // Activation leg — batch CSV ingestion calls activation's /api/cards/register.
  ACTIVATION_SERVICE_URL: z.string().url().default('http://localhost:3002'),
  // Cognito — browser-facing auth.  MFA enforced at the pool level;
  // 'admin' group membership gates access at the middleware level.
  COGNITO_USER_POOL_ID: z.string().default('ap-southeast-2_Db4d1vpIV'),
  COGNITO_CLIENT_ID: z.string().default('7pj9230obhsa6h6vrvk9tru7do'),
});

export { getAdminConfig, _resetAdminConfig };
