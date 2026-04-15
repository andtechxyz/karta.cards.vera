import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// -----------------------------------------------------------------------------
// requireAdminKey — tiny header-based auth gate for the admin surface.
//
// Admin is the only Vera surface reached from a browser that mutates data
// (program CRUD) or reads CHD-adjacent views (vault card list, audit).  We
// don't want the browser signing HMACs; we also don't want cookies, sessions,
// or roles in the prototype.  Solution: a single 32-byte hex API key sent
// as `X-Admin-Key` on every admin API call, compared in constant time to the
// server's configured `ADMIN_API_KEY`.
//
// Why this is "defensible for a prototype":
//   - The key is at rest in env (Secrets Manager in AWS), not in source.
//   - Constant-time compare blocks timing-based recovery.
//   - No server-side state means no session fixation / CSRF surface.
//   - The vault still owns CHD; admin only proxies GET lists + a vaulting POST.
//     So leaking the admin key buys an attacker only what's already protected
//     by HMAC on the vault (store/cards/audit).
// -----------------------------------------------------------------------------

export const ADMIN_KEY_HEADER = 'x-admin-key';

/**
 * Build the middleware against a fixed expected key.  `expectedKey` must be a
 * 64-char hex string (validated by admin env shape).
 */
export function requireAdminKey(expectedKey: string): RequestHandler {
  // Pre-decode once so the hot path is a single timingSafeEqual.
  const expected = Buffer.from(expectedKey, 'hex');
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.get(ADMIN_KEY_HEADER);
    if (!provided) {
      res.status(401).json({ error: { code: 'missing_admin_key', message: 'X-Admin-Key header is required' } });
      return;
    }
    // Only accept the exact hex shape; anything else is rejected before the
    // timing-safe compare so we don't leak "is it even hex?" via branch time.
    if (provided.length !== expected.length * 2 || !/^[0-9a-fA-F]+$/.test(provided)) {
      res.status(401).json({ error: { code: 'invalid_admin_key', message: 'Admin key rejected' } });
      return;
    }
    const got = Buffer.from(provided, 'hex');
    if (!timingSafeEqual(expected, got)) {
      res.status(401).json({ error: { code: 'invalid_admin_key', message: 'Admin key rejected' } });
      return;
    }
    next();
  };
}
