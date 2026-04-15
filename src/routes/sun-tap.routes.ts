import { Router } from 'express';
import { handleSunTap } from '../activation/index.js';

const router: Router = Router();

// GET /activate/:cardRef?e=<picc>&m=<mac>
//
// The endpoint the *physical card* hits when tapped — invoked by the NDEF
// URL the SDM applet emits.  Mounted at the server root (NOT under /api)
// because that's what the URL on the chip looks like.
//
// On valid SUN: redirects to the frontend identity-blind activation page
// with an opaque session token in the query string.  The cardRef in the
// path is NOT echoed to the frontend — the session is the only handle.
//
// On any failure: redirects to /activate with an `?error=` code so the
// frontend can render a friendly message.  We deliberately don't return
// raw JSON here — the cardholder's phone is following the redirect via
// Chrome, not an XHR client.

router.get('/activate/:cardRef', async (req, res) => {
  const cardRef = req.params.cardRef;

  // Reconstruct the URL as the card emitted it.  `trust proxy 1` (set in
  // src/index.ts) makes req.protocol honour Cloudflare's X-Forwarded-Proto.
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  try {
    const result = await handleSunTap({
      cardRef,
      fullUrl,
      ip: req.ip,
      ua: req.get('user-agent') ?? undefined,
    });
    res.redirect(302, `/activate?session=${encodeURIComponent(result.sessionId)}`);
  } catch (e) {
    const code =
      typeof e === 'object' && e !== null && 'code' in e
        ? String((e as { code: unknown }).code)
        : 'sun_error';
    res.redirect(302, `/activate?error=${encodeURIComponent(code)}`);
  }
});

export default router;
