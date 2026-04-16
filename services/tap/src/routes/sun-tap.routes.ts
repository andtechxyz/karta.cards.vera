import { Router } from 'express';
import { prisma } from '@vera/db';
import { handleSunTap } from '../tap.service.js';
import { getTapConfig } from '../env.js';

const router: Router = Router();

// GET /activate/:cardRef?e=<picc>&m=<mac>
//
// The endpoint the *physical card* hits when tapped — invoked by the NDEF
// URL the SDM applet emits.  Mounted at the server root (NOT under /api)
// because that's what the URL on the chip looks like.
//
// On valid SUN: 302s to activation.karta.cards with a signed handoff token
// in the fragment (#hand=<token>).  Fragment is not sent to the server by
// the browser, so Cloudflare logs don't capture the token.
//
// On any failure: redirects to the activation frontend with ?error=<code>
// so the frontend can render a friendly message.

router.get('/activate/:cardRef', async (req, res) => {
  const cardRef = req.params.cardRef;

  // Reconstruct the URL as the card emitted it.  `trust proxy 1` (set in
  // src/index.ts) makes req.protocol honour Cloudflare's X-Forwarded-Proto.
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const config = getTapConfig();

  try {
    const result = await handleSunTap({
      cardRef,
      fullUrl,
      ip: req.ip,
      ua: req.get('user-agent') ?? undefined,
    });

    const token = encodeURIComponent(result.handoffToken);

    // Look up the card's current status to decide where to redirect.
    const card = await prisma.card.findUnique({
      where: { cardRef },
      select: { status: true, programId: true, program: { select: { postActivationNdefUrlTemplate: true } } },
    });

    if (card?.status === 'ACTIVATED') {
      // Card is activated but not yet provisioned — send to provisioning app.
      res.redirect(302, `${config.PROVISIONING_APP_URL}/provision#hand=${token}`);
    } else if (card?.status === 'PROVISIONED') {
      // Already provisioned — redirect to program payment URL or default.
      const paymentUrl = card.program?.postActivationNdefUrlTemplate ?? config.ACTIVATION_URL;
      res.redirect(302, paymentUrl);
    } else {
      // PERSONALISED or unknown — default activation flow.
      res.redirect(302, `${config.ACTIVATION_URL}/activate#hand=${token}`);
    }
  } catch (e) {
    const code =
      typeof e === 'object' && e !== null && 'code' in e
        ? String((e as { code: unknown }).code)
        : 'sun_error';
    res.redirect(302, `${config.ACTIVATION_URL}/activate?error=${encodeURIComponent(code)}`);
  }
});

export default router;
