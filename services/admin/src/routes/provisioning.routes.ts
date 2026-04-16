import { Router } from 'express';
import { z } from 'zod';
import { validateBody, notFound } from '@vera/core';
import { prisma } from '@vera/db';

// CRUD for ChipProfile, IssuerProfile, and read-only provisioning monitor.
// Mounted under /api/admin behind the same HMAC gate as other admin routes.

const router: Router = Router();

// ---------------------------------------------------------------------------
// Chip Profiles
// ---------------------------------------------------------------------------

const createChipProfileSchema = z.object({
  name: z.string().min(1).max(128),
  scheme: z.string().min(1),
  vendor: z.string().min(1),
  cvn: z.coerce.number().int(),
  dgiDefinitions: z.any(),
  elfAid: z.string().optional(),
  moduleAid: z.string().optional(),
  paAid: z.string().optional(),
  fidoAid: z.string().optional(),
});

router.get('/chip-profiles', async (_req, res) => {
  const profiles = await prisma.chipProfile.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(profiles);
});

router.post('/chip-profiles', validateBody(createChipProfileSchema), async (req, res) => {
  const profile = await prisma.chipProfile.create({ data: req.body });
  res.status(201).json(profile);
});

router.get('/chip-profiles/:id', async (req, res) => {
  const profile = await prisma.chipProfile.findUnique({ where: { id: req.params.id } });
  if (!profile) throw notFound('chip_profile_not_found', `ChipProfile ${req.params.id} not found`);
  res.json(profile);
});

router.delete('/chip-profiles/:id', async (req, res) => {
  try {
    await prisma.chipProfile.delete({ where: { id: req.params.id } });
  } catch {
    throw notFound('chip_profile_not_found', `ChipProfile ${req.params.id} not found`);
  }
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Issuer Profiles
// ---------------------------------------------------------------------------

const createIssuerProfileSchema = z.object({
  programId: z.string().min(1),
  chipProfileId: z.string().min(1),
  scheme: z.string().min(1),
  cvn: z.coerce.number().int(),
  imkAlgorithm: z.string().optional(),
  derivationMethod: z.string().optional(),
  tmkKeyArn: z.string().optional(),
  imkAcKeyArn: z.string().optional(),
  imkSmiKeyArn: z.string().optional(),
  imkSmcKeyArn: z.string().optional(),
  imkIdnKeyArn: z.string().optional(),
  issuerPkKeyArn: z.string().optional(),
  aid: z.string().optional(),
  appLabel: z.string().optional(),
});

const patchIssuerProfileSchema = createIssuerProfileSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be supplied',
  });

router.get('/issuer-profiles', async (_req, res) => {
  const profiles = await prisma.issuerProfile.findMany({
    include: { program: { select: { id: true, name: true } }, chipProfile: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(profiles);
});

router.post('/issuer-profiles', validateBody(createIssuerProfileSchema), async (req, res) => {
  const profile = await prisma.issuerProfile.create({ data: req.body });
  res.status(201).json(profile);
});

router.patch('/issuer-profiles/:id', validateBody(patchIssuerProfileSchema), async (req, res) => {
  try {
    const profile = await prisma.issuerProfile.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(profile);
  } catch {
    throw notFound('issuer_profile_not_found', `IssuerProfile ${req.params.id} not found`);
  }
});

// ---------------------------------------------------------------------------
// Provisioning Monitor
// ---------------------------------------------------------------------------

router.get('/provisioning/stats', async (_req, res) => {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [activeSessions, provisioned24h, totalProvisioned, failedSessions24h] = await Promise.all([
    prisma.provisioningSession.count({
      where: { phase: { notIn: ['COMPLETE', 'FAILED'] } },
    }),
    prisma.provisioningSession.count({
      where: { phase: 'COMPLETE', completedAt: { gte: twentyFourHoursAgo } },
    }),
    prisma.provisioningSession.count({
      where: { phase: 'COMPLETE' },
    }),
    prisma.provisioningSession.count({
      where: { phase: 'FAILED', failedAt: { gte: twentyFourHoursAgo } },
    }),
  ]);

  res.json({ activeSessions, provisioned24h, totalProvisioned, failedSessions24h });
});

router.get('/provisioning/sessions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const sessions = await prisma.provisioningSession.findMany({
    take: limit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
    include: {
      card: { select: { id: true, cardRef: true, status: true } },
      sadRecord: { select: { id: true, proxyCardId: true, status: true } },
    },
  });
  res.json(sessions);
});

export default router;
