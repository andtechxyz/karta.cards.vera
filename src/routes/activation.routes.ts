import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import {
  beginActivationRegistration,
  finishActivationRegistration,
} from '../activation/index.js';

const router: Router = Router();

// POST /api/activation/sessions/:token/begin
//   Returns WebAuthn registration options for the cardholder's phone.
router.post('/sessions/:token/begin', async (req, res) => {
  const options = await beginActivationRegistration(req.params.token);
  res.json(options);
});

// POST /api/activation/sessions/:token/finish
//   Verifies the AttestationResponse + atomically: creates the credential,
//   flips Card → ACTIVATED, consumes the session.
const finishSchema = z.object({
  response: z.unknown(), // SimpleWebAuthn's RegistrationResponseJSON
  deviceLabel: z.string().max(128).optional(),
});

router.post('/sessions/:token/finish', validateBody(finishSchema), async (req, res) => {
  const result = await finishActivationRegistration({
    sessionToken: req.params.token,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: req.body.response as any,
    deviceLabel: req.body.deviceLabel,
  });
  res.json(result);
});

export default router;
