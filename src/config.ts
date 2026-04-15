import 'dotenv/config';
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Environment schema.
//
// RP-ID and RP origin are *required* — we never infer from Host header, per
// New T4T's hard-won lesson.  See /Users/danderson/.claude/plans/tingly-
// imagining-sketch.md, "WebAuthn/NFC requirements".
// -----------------------------------------------------------------------------

/** Zod schema for a fixed-length hex string (`bytes` bytes = `bytes*2` chars). */
export const hexKey = (bytes: number) =>
  z
    .string()
    .length(bytes * 2, `expected ${bytes} bytes (${bytes * 2} hex chars)`)
    .regex(/^[0-9a-fA-F]+$/);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),

  // WebAuthn
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGIN: z.string().url(),
  WEBAUTHN_RP_NAME: z.string().default('Palisade Pay'),

  // Vault keys — 32 bytes each, hex-encoded
  VAULT_KEY_V1: hexKey(32),
  VAULT_KEY_ACTIVE_VERSION: z.coerce.number().int().positive().default(1),
  VAULT_FINGERPRINT_KEY: hexKey(32),

  // ARQC root seed — 32 bytes hex
  VERA_ROOT_ARQC_SEED: hexKey(32),

  // Payment provider
  PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Session TTLs
  TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  RETRIEVAL_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type VeraConfig = z.infer<typeof envSchema>;

let cached: VeraConfig | null = null;

export function getConfig(): VeraConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only helper to reset the cached config. */
export function _resetConfigCache(): void {
  cached = null;
}
