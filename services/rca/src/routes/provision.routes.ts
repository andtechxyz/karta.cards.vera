/**
 * POST /api/provision/start — Initiate a provisioning session.
 *
 * Returns { sessionId, wsUrl } for the mobile app to connect.
 */

import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '@vera/core';

import { SessionManager } from '../services/session-manager.js';

const startSchema = z.object({
  proxyCardId: z.string().min(1),
});

export function createProvisionRouter(): Router {
  const router = Router();
  const sessionManager = new SessionManager();

  router.post('/start', async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('validation_failed', parsed.error.message);

    const session = await sessionManager.startSession(parsed.data.proxyCardId);

    // Build WebSocket URL — same host, different path
    const host = req.get('host') ?? 'localhost:3007';
    const proto = req.secure ? 'wss' : 'ws';
    const wsUrl = `${proto}://${host}/api/provision/relay/${session.sessionId}`;

    res.status(201).json({
      sessionId: session.sessionId,
      wsUrl,
      proxyCardId: session.proxyCardId,
    });
  });

  return router;
}
