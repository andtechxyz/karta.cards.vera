import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ADMIN_KEY_HEADER, requireAdminKey } from './require-admin-key.js';

// One fixed key, one guard-shape: every failure path returns 401 with a
// distinct error code so the admin UI can tell "missing" from "wrong".

const KEY = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

function runMw(providedHeader: string | undefined) {
  const mw = requireAdminKey(KEY);
  const req = { get: (h: string) => (h.toLowerCase() === ADMIN_KEY_HEADER ? providedHeader : undefined) } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  const next = vi.fn();
  mw(req, res, next);
  return { status, json, next };
}

describe('requireAdminKey', () => {
  it('calls next() when the header matches exactly', () => {
    const { status, next } = runMw(KEY);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('401 missing_admin_key when header is absent', () => {
    const { status, json, next } = runMw(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'missing_admin_key' }) }),
    );
  });

  it('401 invalid_admin_key when header is the wrong length', () => {
    const { status, json, next } = runMw('short');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_admin_key' }) }),
    );
  });

  it('401 invalid_admin_key when header has non-hex characters', () => {
    const { status, next } = runMw('z'.repeat(64));
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('401 invalid_admin_key when header is the right shape but wrong value', () => {
    const { status, json, next } = runMw(WRONG);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_admin_key' }) }),
    );
  });

  it('accepts mixed-case hex (header is case-insensitive on value)', () => {
    const { next } = runMw(KEY.toUpperCase());
    expect(next).toHaveBeenCalledOnce();
  });
});
