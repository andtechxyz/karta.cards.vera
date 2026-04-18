import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import {
  beginActivationRegistration,
  finishActivationRegistration,
  exchangeHandoffForSession,
} from '../activation/index.js';

const router: Router = Router();

// POST /api/activation/handoff
//   Frontend extracts #hand=<token> from URL fragment, POSTs here.
//   Returns a server-side sessionToken the frontend then uses for begin/finish.
const handoffSchema = z.object({
  token: z.string().min(1),
});

router.post('/handoff', validateBody(handoffSchema), async (req, res) => {
  const result = await exchangeHandoffForSession(
    req.body.token,
    req.ip,
    req.get('user-agent') ?? undefined,
  );
  res.json(result);
});

// POST /api/activation/sessions/:token/begin
router.post('/sessions/:token/begin', async (req, res) => {
  const options = await beginActivationRegistration(req.params.token);
  res.json(options);
});

// POST /api/activation/sessions/:token/finish
//
// Accepts either:
//   { response: <AttestationResponseJSON>, deviceLabel? } — register mode
//   { confirm: true, deviceLabel? }                       — confirm mode
//
// Exactly one of response / confirm must be present; refine() enforces that
// rather than letting the service handler discover the mismatch later.
const finishSchema = z
  .object({
    response: z.unknown().optional(),
    confirm: z.literal(true).optional(),
    deviceLabel: z.string().max(128).optional(),
  })
  .refine((b) => (b.response !== undefined) !== (b.confirm === true), {
    message: 'exactly one of { response } (register) or { confirm: true } must be supplied',
  });

router.post('/sessions/:token/finish', validateBody(finishSchema), async (req, res) => {
  const body = req.body as z.infer<typeof finishSchema>;
  const result = await finishActivationRegistration({
    sessionToken: req.params.token,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: body.response as any,
    confirm: body.confirm,
    deviceLabel: body.deviceLabel,
  });
  res.json(result);
});

export default router;
