import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const ADMIN_KEY_HEADER = 'x-admin-key';

/**
 * Build the middleware against a fixed expected key.  `expectedKey` must be a
 * 64-char hex string (validated by env shape).
 */
export function requireAdminKey(expectedKey: string): RequestHandler {
  const expected = Buffer.from(expectedKey, 'hex');
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.get(ADMIN_KEY_HEADER);
    if (!provided) {
      res.status(401).json({ error: { code: 'missing_admin_key', message: 'X-Admin-Key header is required' } });
      return;
    }
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
