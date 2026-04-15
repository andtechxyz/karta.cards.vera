import 'dotenv/config';
import { z, type ZodRawShape, type ZodObject } from 'zod';

// -----------------------------------------------------------------------------
// Shared env schema fragments.
//
// Each service extends `baseEnv` with its own fields via `defineEnv(extraShape)`.
// RP-ID is `karta.cards` (the apex) so credentials minted on any subdomain are
// usable across the whole ecosystem.  `WEBAUTHN_ORIGINS` is a comma-separated
// list of full origins allowed in clientDataJSON verification.
// -----------------------------------------------------------------------------

/** Zod schema for a fixed-length hex string (`bytes` bytes = `bytes*2` chars). */
export const hexKey = (bytes: number) =>
  z
    .string()
    .length(bytes * 2, `expected ${bytes} bytes (${bytes * 2} hex chars)`)
    .regex(/^[0-9a-fA-F]+$/);

/** Comma-separated list of URLs → string[] after trim + filter. */
export const originList = z
  .string()
  .min(1)
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).min(1));

export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
} as const;

/**
 * Build a process-wide config loader from a zod shape.  Caches the parsed
 * result; exposes `_reset()` for tests.
 */
export function defineEnv<Shape extends ZodRawShape>(shape: Shape) {
  const schema: ZodObject<Shape> = z.object(shape);
  type Env = z.infer<typeof schema>;
  let cached: Env | null = null;

  function get(): Env {
    if (cached) return cached;
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${msg}`);
    }
    cached = parsed.data;
    return cached;
  }

  function reset(): void {
    cached = null;
  }

  return { get, reset, schema };
}
