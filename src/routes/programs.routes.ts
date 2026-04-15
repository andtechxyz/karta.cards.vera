import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import {
  createProgram,
  currencySchema,
  getProgram,
  listPrograms,
  resolveNdefUrlsByCardRef,
  resolveNdefUrlsForCard,
  tierRuleSetSchema,
  updateProgram,
} from '../programs/index.js';

// -----------------------------------------------------------------------------
// Program admin routes.  Called by the Palisade admin surface to configure
// card products: name, currency, tier rules, and the NDEF URL templates the
// updater writes to the card pre- and post-activation.
//
// GET  /api/programs             — list all
// GET  /api/programs/:id         — fetch one
// POST /api/programs             — create
// PATCH /api/programs/:id        — partial update (any subset of fields)
// GET  /api/programs/cards/:cardId/ndef-urls
//                                — resolve rendered NDEF URLs for a given
//                                  card (Palisade calls this at perso time
//                                  and after successful activation).
// -----------------------------------------------------------------------------

const router: Router = Router();

const upsertBaseSchema = z.object({
  name: z.string().min(1).max(128),
  currency: currencySchema,
  tierRules: tierRuleSetSchema,
  preActivationNdefUrlTemplate: z.string().url().nullable().optional(),
  postActivationNdefUrlTemplate: z.string().url().nullable().optional(),
});

const createSchema = upsertBaseSchema.extend({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i, 'program id must be alphanumeric + _ -'),
});

const patchSchema = upsertBaseSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be supplied',
  });

router.post('/', validateBody(createSchema), async (req, res) => {
  const program = await createProgram(req.body);
  res.status(201).json(program);
});

router.patch('/:id', validateBody(patchSchema), async (req, res) => {
  const program = await updateProgram(req.params.id, req.body);
  res.json(program);
});

router.get('/', async (_req, res) => {
  res.json(await listPrograms());
});

router.get('/:id', async (req, res) => {
  res.json(await getProgram(req.params.id));
});

// Palisade updater hitting this by cardRef (the slug it already knows) is
// friendlier than looking up the cuid first.
router.get('/cards/by-ref/:cardRef/ndef-urls', async (req, res) => {
  res.json(await resolveNdefUrlsByCardRef(req.params.cardRef));
});

router.get('/cards/:cardId/ndef-urls', async (req, res) => {
  res.json(await resolveNdefUrlsForCard(req.params.cardId));
});

export default router;
