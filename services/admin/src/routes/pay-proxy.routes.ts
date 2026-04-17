import { Router } from 'express';
import { request } from 'undici';
import { ApiError } from '@vera/core';
import { getAdminConfig } from '../env.js';

// -----------------------------------------------------------------------------
// Admin → pay proxy.  The admin UI lists/reads transactions.
//
// Pay service keeps X-Admin-Key for M2M automation (merchants creating
// transactions, operators registering cards).  The admin browser already
// authenticated via Cognito + admin group check; this proxy adds the
// pay service's admin key on the server side so the browser never sees it.
// -----------------------------------------------------------------------------

const router: Router = Router();

async function proxyGet(path: string) {
  const config = getAdminConfig();
  const url = `${config.PAY_SERVICE_URL.replace(/\/$/, '')}${path}`;
  const resp = await request(url, {
    method: 'GET',
    headers: { 'x-admin-key': config.PAY_ADMIN_API_KEY },
  });
  const text = await resp.body.text();
  const data = text ? JSON.parse(text) : undefined;
  if (resp.statusCode >= 400) {
    const code = data?.error?.code ?? 'pay_error';
    const message = data?.error?.message ?? `Pay service returned ${resp.statusCode}`;
    throw new ApiError(resp.statusCode, code, message);
  }
  return data;
}

router.get('/transactions', async (_req, res) => {
  const data = await proxyGet('/api/transactions');
  res.json(data);
});

router.get('/transactions/:rlid', async (req, res) => {
  const data = await proxyGet(`/api/transactions/${encodeURIComponent(req.params.rlid)}`);
  res.json(data);
});

export default router;
