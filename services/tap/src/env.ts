import { defineEnv, baseEnvShape, cryptoEnvShape } from '@vera/core';
import { z } from 'zod';

const { get: getTapConfig, reset: _resetTapConfig } = defineEnv({
  ...baseEnvShape,
  ...cryptoEnvShape,
  PORT: z.coerce.number().int().positive().default(3001),
  TAP_HANDOFF_SECRET: z.string().min(32),
  ACTIVATION_URL: z.string().url(),
});

export { getTapConfig, _resetTapConfig };
