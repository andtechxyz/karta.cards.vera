import { defineEnv, baseEnvShape, authKeysJson } from '@vera/core';
import { z } from 'zod';

const { get: getRcaConfig, reset: _resetRcaConfig } = defineEnv({
  ...baseEnvShape,

  PORT: z.coerce.number().default(3007),

  // HMAC auth — who can call us
  PROVISION_AUTH_KEYS: authKeysJson,

  // Data-prep service URL (internal ALB)
  DATA_PREP_SERVICE_URL: z.string().url().default('http://localhost:3006'),

  // Callback URL for notifying activation service on completion
  ACTIVATION_CALLBACK_URL: z.string().url().default('http://localhost:3002'),

  // HMAC secret for signing callbacks
  CALLBACK_HMAC_SECRET: z.string().min(1).default('0'.repeat(64)),

  // WebSocket reconnect timeout
  WS_TIMEOUT_SECONDS: z.coerce.number().default(30),
});

export { getRcaConfig, _resetRcaConfig };
