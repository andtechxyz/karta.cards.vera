import { defineEnv, baseEnvShape, vaultPanCryptoEnvShape } from '@vera/core';
import { z } from 'zod';

const { get: getVaultConfig, reset: _resetVaultConfig } = defineEnv({
  ...baseEnvShape,
  ...vaultPanCryptoEnvShape,
  PORT: z.coerce.number().int().positive().default(3004),
  RETRIEVAL_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
});

export { getVaultConfig, _resetVaultConfig };
