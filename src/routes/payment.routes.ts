import { Router } from 'express';
import { sseBus } from '../realtime/index.js';
import { getTransactionByRlid } from '../transactions/index.js';

const router: Router = Router();

// -----------------------------------------------------------------------------
// GET /api/payment/status/:rlid  —  Server-Sent Events stream.
//
// Subscribed to by both the merchant desktop page and the customer phone
// page.  The SSE bus replays the last ~20 events for this rlid on connect,
// so a phone that lands on /pay/{rlid} after the merchant has already seen
// `authn_started` will still receive it.
//
// The 15s heartbeat is owned by the bus itself (Cloudflare Tunnel cuts idle
// streams around the 100s mark).
// -----------------------------------------------------------------------------

router.get('/status/:rlid', async (req, res) => {
  // Validate the rlid exists so we don't open streams for typos.  Using
  // getTransactionByRlid ensures we also run the opportunistic EXPIRED
  // transition if the phone arrives well after the QR's TTL.
  const txn = await getTransactionByRlid(req.params.rlid);

  const unsubscribe = sseBus.subscribe(txn.rlid, res);

  req.on('close', () => {
    unsubscribe();
    try {
      res.end();
    } catch {
      // stream already closed
    }
  });
});

export default router;
