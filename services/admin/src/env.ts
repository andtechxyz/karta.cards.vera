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
  // Pay leg — admin UI proxies transaction list/detail from pay service.
  PAY_SERVICE_URL: z.string().url().default('http://localhost:3003'),
  // Admin key for calling pay service's admin-gated endpoints (transactions).
  // Still required by pay service for M2M calls.
  PAY_ADMIN_API_KEY: hexKey(32),
  // Cognito — browser-facing auth.  MFA enforced at the pool level;
  // 'admin' group membership gates access at the middleware level.
  COGNITO_USER_POOL_ID: z.string().default('ap-southeast-2_Db4d1vpIV'),
  COGNITO_CLIENT_ID: z.string().default('7pj9230obhsa6h6vrvk9tru7do'),
  // --- Microsites ---------------------------------------------------------
  // S3 bucket that backs microsite.karta.cards (served via CloudFront OAC).
  // Admin uploads zips here; the CDN rewrites /programs/<id>/... to the
  // currently-active MicrositeVersion's S3 prefix.
  MICROSITE_BUCKET: z.string().default('karta-microsites-600743178530'),
  MICROSITE_CDN_URL: z.string().url().default('https://microsite.karta.cards'),
  // --- Embossing ----------------------------------------------------------
  // S3 bucket storing encrypted raw embossing batch files (SSE-KMS) and the
  // AES-256-GCM DEK for per-FI template-file encryption at rest in the DB.
  // Keyspace is distinct from the vault PAN DEK — templates are format specs,
  // not cardholder data (PANs inside a batch still route through the vault).
  EMBOSSING_BUCKET: z.string().default('karta-embossing-files-600743178530'),
  EMBOSSING_KMS_KEY_ARN: z.string().default(''),
  EMBOSSING_KEY_V1: hexKey(32).default('0'.repeat(64)),
  EMBOSSING_KEY_ACTIVE_VERSION: z.coerce.number().int().positive().default(1),
});

export { getAdminConfig, _resetAdminConfig };
