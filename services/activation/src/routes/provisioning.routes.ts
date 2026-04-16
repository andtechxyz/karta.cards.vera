import { Router } from 'express';
import { prisma } from '@vera/db';
import { badRequest, notFound } from '@vera/core';
import { verifyHandoff } from '@vera/handoff';
import { createCognitoAuthMiddleware } from '@vera/cognito-auth';
import { requireSignedRequest } from '@vera/service-auth';
import { request } from 'undici';
import { getActivationConfig } from '../env.js';

export function createProvisioningRouter(): Router {
  const router = Router();
  const config = getActivationConfig();

  const cognitoAuth = createCognitoAuthMiddleware({
    userPoolId: config.COGNITO_USER_POOL_ID,
    clientId: config.COGNITO_CLIENT_ID,
  });

  // POST /api/provisioning/start — start provisioning session (Cognito-authed)
  router.post('/start', cognitoAuth, async (req, res) => {
    const { handoffToken } = req.body as { handoffToken?: string };
    if (!handoffToken) throw badRequest('missing_token', 'handoffToken is required');

    // Verify handoff token
    const payload = verifyHandoff({
      token: handoffToken,
      expectedPurpose: 'provisioning',
      secretHex: config.TAP_HANDOFF_SECRET,
    });

    // Look up card
    const card = await prisma.card.findUnique({
      where: { id: payload.sub },
      select: { id: true, cardRef: true, status: true, proxyCardId: true, cognitoSub: true },
    });
    if (!card) throw notFound('card_not_found', 'Card not found');
    if (card.status !== 'ACTIVATED') throw badRequest('invalid_status', `Card is ${card.status}, expected ACTIVATED`);

    if (!config.PALISADE_RCA_URL) {
      throw badRequest('rca_not_configured', 'PALISADE_RCA_URL is not configured');
    }

    // Call Palisade RCA to start provisioning
    const rcaResp = await request(`${config.PALISADE_RCA_URL}/api/v1/provision/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proxy_card_id: card.proxyCardId,
        activation_token: handoffToken,
      }),
    });

    const rcaBody = (await rcaResp.body.json()) as { session_id: string; ws_url: string };

    if (rcaResp.statusCode >= 400) {
      throw badRequest('rca_error', 'Failed to start provisioning session');
    }

    // Create local provisioning session
    await prisma.provisioningSession.create({
      data: {
        cardId: card.id,
        sadRecordId: '', // Will be linked by RCA callback
        proxyCardId: card.proxyCardId ?? '',
        rcaSessionId: rcaBody.session_id,
        phase: 'INIT',
      },
    });

    // Link card to mobile user on first provisioning
    const cognitoUser = req.cognitoUser!;
    if (!card.cognitoSub) {
      await prisma.card.update({
        where: { id: card.id },
        data: { cognitoSub: cognitoUser.sub },
      });
    }

    res.status(201).json({
      sessionId: rcaBody.session_id,
      wsUrl: rcaBody.ws_url,
    });
  });

  // POST /api/provisioning/callback — RCA completion callback (HMAC-signed, NOT Cognito)
  const hmacGate = requireSignedRequest({ keys: config.PROVISION_AUTH_KEYS });
  router.post('/callback', hmacGate, async (req, res) => {
    // This endpoint is called by the RCA service, not the mobile app.
    // It's HMAC-signed via the requireSignedRequest middleware mounted in index.ts.
    const { proxy_card_id, session_id, provisioned_at } = req.body as {
      proxy_card_id?: string;
      session_id?: string;
      provisioned_at?: string;
      [key: string]: unknown;
    };

    if (!proxy_card_id) throw badRequest('missing_field', 'proxy_card_id is required');

    // Find the card by proxyCardId
    const card = await prisma.card.findFirst({
      where: { proxyCardId: proxy_card_id },
    });
    if (!card) throw notFound('card_not_found', `No card with proxyCardId ${proxy_card_id}`);

    // Transition card to PROVISIONED
    await prisma.card.update({
      where: { id: card.id },
      data: {
        status: 'PROVISIONED',
        provisionedAt: provisioned_at ? new Date(provisioned_at) : new Date(),
      },
    });

    // Update local provisioning session if it exists
    if (session_id) {
      const session = await prisma.provisioningSession.findFirst({
        where: { rcaSessionId: session_id },
      });
      if (session) {
        await prisma.provisioningSession.update({
          where: { id: session.id },
          data: { phase: 'COMPLETE', completedAt: new Date() },
        });
      }
    }

    res.json({ status: 'ok', cardRef: card.cardRef });
  });

  return router;
}
