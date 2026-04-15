import { Router } from 'express';
import { z } from 'zod';
import { listAuditEvents } from '../vault/index.js';

const router: Router = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get('/audit', async (req, res) => {
  const { limit, offset } = querySchema.parse(req.query);
  const rows = await listAuditEvents(limit, offset);
  res.json(rows);
});

export default router;
