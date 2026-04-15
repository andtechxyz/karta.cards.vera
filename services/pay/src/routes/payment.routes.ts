import { Router } from 'express';
import { sseBus } from '../realtime/index.js';
import { getTransactionByRlid } from '../transactions/index.js';

const router: Router = Router();

// GET /api/payment/status/:rlid — Server-Sent Events stream.
router.get('/status/:rlid', async (req, res) => {
  const txn = await getTransactionByRlid(req.params.rlid);
  const unsubscribe = sseBus.subscribe(txn.rlid, res);
  req.on('close', () => {
    unsubscribe();
    try { res.end(); } catch { /* already closed */ }
  });
});

export default router;
