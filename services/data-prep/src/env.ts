import { defineEnv, baseEnvShape, authKeysJson } from '@vera/core';
import { z } from 'zod';

const { get: getDataPrepConfig, reset: _resetDataPrepConfig } = defineEnv({
  ...baseEnvShape,

  PORT: z.coerce.number().default(3006),

  // HMAC auth — who can call us (activation, admin)
  PROVISION_AUTH_KEYS: authKeysJson,

  // AWS region for Payment Cryptography and KMS
  AWS_REGION: z.string().default('ap-southeast-2'),

  // KMS key for encrypting SAD blobs at rest
  KMS_SAD_KEY_ARN: z.string().default(''),

  // SAD record TTL in days
  SAD_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export { getDataPrepConfig, _resetDataPrepConfig };
