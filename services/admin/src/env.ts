import { defineEnv, baseEnvShape, hexKey, originList } from '@vera/core';
import { z } from 'zod';

// Vera-side admin — only the vault-proxy and pay-proxy routes live here.
// Card-domain env (activation, embossing, microsites) moved to Palisade in
// Phase 4a.
const { get: getAdminConfig, reset: _resetAdminConfig } = defineEnv({
  ...baseEnvShape,
  CORS_ORIGINS: originList,
  PORT: z.coerce.number().int().positive().default(3005),
  // Vault leg — admin backend signs outbound vault calls as keyId='admin'.
  VAULT_SERVICE_URL: z.string().url().default('http://localhost:3004'),
  SERVICE_AUTH_ADMIN_SECRET: hexKey(32),
  // Pay leg — admin UI proxies transaction list/detail from pay service.
  PAY_SERVICE_URL: z.string().url().default('http://localhost:3003'),
  PAY_ADMIN_API_KEY: hexKey(32),
  // Cognito — browser-facing auth.  MFA enforced at the pool level;
  // 'admin' group membership gates access at the middleware level.
  COGNITO_USER_POOL_ID: z.string().default('ap-southeast-2_Db4d1vpIV'),
  COGNITO_CLIENT_ID: z.string().default('7pj9230obhsa6h6vrvk9tru7do'),
});

export { getAdminConfig, _resetAdminConfig };
