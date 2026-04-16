/**
 * rca — Real-time Card Personalisation Agent (provisioning relay orchestrator).
 *
 * Internal service on port 3007. Exposes a REST endpoint to start sessions
 * and a WebSocket endpoint for APDU relay between the mobile app and the
 * card's Provisioning Agent applet.
 *
 * No CORS — service-to-service only (internal ALB, HMAC-gated).
 */

import 'dotenv/config';
import 'express-async-errors';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { requireSignedRequest, captureRawBody } from '@vera/service-auth';
import { errorMiddleware } from '@vera/core';

import { getRcaConfig } from './env.js';
import { createProvisionRouter } from './routes/provision.routes.js';
import { handleRelayConnection } from './ws/relay-handler.js';

const config = getRcaConfig();
const app = express();
const server = createServer(app);

app.set('trust proxy', 1);

// Health check (unauthenticated)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'rca' });
});

// HMAC-gated REST endpoint
const authGate = requireSignedRequest({ keys: config.PROVISION_AUTH_KEYS });
app.use(
  '/api/provision',
  express.json({ limit: '64kb', verify: captureRawBody }),
  authGate,
  createProvisionRouter(),
);

app.use(errorMiddleware);

// ---------------------------------------------------------------------------
// WebSocket server for APDU relay
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  server,
  path: undefined, // We handle path routing ourselves
});

wss.on('connection', (ws, req) => {
  // Extract session ID from path: /api/provision/relay/:sessionId
  const match = req.url?.match(/\/api\/provision\/relay\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    ws.close(4000, 'Invalid path — expected /api/provision/relay/:sessionId');
    return;
  }

  const sessionId = match[1];
  handleRelayConnection(ws, sessionId);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const port = config.PORT;
server.listen(port, () => {
  console.log(`[rca] listening on :${port} (HTTP + WebSocket)`);
});

export default app;
