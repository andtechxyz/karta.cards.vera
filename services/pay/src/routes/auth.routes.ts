import { Router } from 'express';
import { z } from 'zod';
import { CredentialKind } from '@prisma/client';
import { validateBody, badRequest } from '@vera/core';
import {
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
} from '../webauthn/index.js';
import { getTransactionForAuthOrThrow } from '../transactions/index.js';
import { orchestratePostAuth } from '../orchestration/index.js';

const router: Router = Router();

// --- Registration (dev/admin path) -----------------------------------------

const beginRegSchema = z.object({
  cardId: z.string().min(1),
  kind: z.nativeEnum(CredentialKind),
});

router.post('/register/options', validateBody(beginRegSchema), async (req, res) => {
  const options = await beginRegistration(req.body);
  res.json(options);
});

const finishRegSchema = z.object({
  cardId: z.string().min(1),
  response: z.unknown(),
  deviceName: z.string().max(128).optional(),
});

router.post('/register/verify', validateBody(finishRegSchema), async (req, res) => {
  const cred = await finishRegistration({
    cardId: req.body.cardId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: req.body.response as any,
    deviceName: req.body.deviceName,
  });
  res.status(201).json({
    id: cred.id,
    credentialId: cred.credentialId,
    kind: cred.kind,
    deviceName: cred.deviceName,
  });
});

// --- Authentication --------------------------------------------------------

const beginAuthSchema = z.object({
  rlid: z.string().min(1),
  kinds: z.array(z.nativeEnum(CredentialKind)).optional(),
});

router.post('/authenticate/options', validateBody(beginAuthSchema), async (req, res) => {
  const txn = await getTransactionForAuthOrThrow(req.body.rlid);
  const requested = req.body.kinds;
  const effective = requested
    ? txn.allowedCredentialKinds.filter((k) => requested.includes(k))
    : txn.allowedCredentialKinds;
  if (effective.length === 0) {
    throw badRequest(
      'no_allowed_kinds',
      'Requested credential kinds are not acceptable for this transaction',
    );
  }
  const options = await beginAuthentication({
    cardId: txn.cardId,
    challenge: txn.challengeNonce,
    kinds: effective,
  });
  res.json(options);
});

const finishAuthSchema = z.object({
  rlid: z.string().min(1),
  response: z.unknown(),
});

router.post('/authenticate/verify', validateBody(finishAuthSchema), async (req, res) => {
  const txn = await getTransactionForAuthOrThrow(req.body.rlid);
  const auth = await finishAuthentication({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: req.body.response as any,
    expectedChallenge: txn.challengeNonce,
    allowedKinds: txn.allowedCredentialKinds,
  });

  const result = await orchestratePostAuth({
    transactionId: txn.id,
    usedCredentialId: auth.credentialId,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
  });
  res.json(result);
});

export default router;
