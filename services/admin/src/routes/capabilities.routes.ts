import { Router } from 'express';
import { getAdminConfig } from '../env.js';

// GET /api/capabilities — unauthenticated.  The shared admin SPA fetches this
// before it has a Cognito token so it knows which tab groups to render.
// Revealing `hasPalisade` to anonymous callers leaks nothing sensitive; it
// only answers "does this deployment claim to speak to a Palisade backend?".

const router: Router = Router();

router.get('/', (_req, res) => {
  const config = getAdminConfig();
  res.json({
    hasVera: true,
    hasPalisade: config.HAS_PALISADE,
  });
});

export default router;
