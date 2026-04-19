import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@vera/db';
import { badRequest, gone, notFound, unauthorized, validateBody } from '@vera/core';
import { signHandoff } from '@vera/handoff';
import { findCardByPicc } from '../sun/find-card.js';
import {
  deriveSessionKeys,
  extractSdmmacInput,
  verifySdmmac,
} from '../sun/index.js';
import { getTapConfig } from '../env.js';
import { getCardFieldKeyProvider } from '../key-provider.js';

// Mobile-app facing entry point for cardRef-less SUN URLs.  Given the raw
// SUN params the chip emits — `?e=<picc-hex>&m=<mac-hex>` — verify the tap
// is authentic and (if so) mint a 30s `provisioning` handoff token the app
// can swap at /api/provisioning/start.
//
// Two route shapes, same logic:
//
//   1. POST /api/tap/verify/:urlCode  — Phase-1 url-coded.  Scopes the
//      trial-decrypt to one program (faster as the fleet grows).  The
//      MAC input includes the urlCode in the path, matching what the chip
//      signed under https://mobile.karta.cards/t/<urlCode>.
//
//   2. POST /api/tap/verify           — catch-all.  Trial-decrypts across
//      EVERY ACTIVATED/PROVISIONED card.  Used by the mobile app today
//      because its current call doesn't carry the urlCode.  We auto-probe
//      every program's URL shape to find the one whose MAC matches.
//      Acceptable while the fleet is small; revert to (1) when we add the
//      urlCode to the app's API call.
//
// Auth is the SUN signature itself — no Cognito.  Rate-limited upstream.

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_16 = /^[0-9a-fA-F]{16}$/;

const verifySchema = z.object({
  e: z.string().regex(HEX_32, 'e must be 32 hex chars (encrypted PICC)'),
  m: z.string().regex(HEX_16, 'm must be 16 hex chars (truncated SDM MAC)'),
});

const URL_CODE_RE = /^[a-z0-9]{2,8}$/;

const router: Router = Router();

// ---------------------------------------------------------------------------
// Route 1: url-coded variant
// ---------------------------------------------------------------------------
router.post('/verify/:urlCode', validateBody(verifySchema), async (req, res) => {
  const urlCode = req.params.urlCode;
  if (!URL_CODE_RE.test(urlCode)) {
    throw badRequest('invalid_url_code', 'urlCode must be 2-8 chars [a-z0-9]');
  }
  const { e: piccHex, m: macHex } = req.body as { e: string; m: string };

  // Resolve program first — narrows trial-decrypt scope, and lets us reject
  // unknown urlCodes upfront with a distinct error code.
  const program = await prisma.program.findUnique({
    where: { urlCode },
    select: { id: true, urlCode: true },
  });
  if (!program) {
    throw notFound('program_not_found', `No program with urlCode "${urlCode}"`);
  }

  await runVerify(req, res, {
    piccHex,
    macHex,
    programId: program.id,
    candidateUrlCodes: [program.urlCode!],
  });
});

// ---------------------------------------------------------------------------
// Route 2: catch-all variant (current mobile app shape)
// ---------------------------------------------------------------------------
router.post('/verify', validateBody(verifySchema), async (req, res) => {
  const { e: piccHex, m: macHex } = req.body as { e: string; m: string };

  // Pull every program's urlCode so we can re-derive the MAC input under
  // each one.  In practice there are 1–5 programs; with one matching card
  // the right urlCode is whichever lets the MAC verify.
  const programs = await prisma.program.findMany({
    where: { urlCode: { not: null } },
    select: { urlCode: true },
  });
  const urlCodes = programs
    .map((p) => p.urlCode)
    .filter((u): u is string => !!u);

  await runVerify(req, res, {
    piccHex,
    macHex,
    programId: undefined, // trial-decrypt across ALL programs
    candidateUrlCodes: urlCodes,
  });
});

// ---------------------------------------------------------------------------
// Shared body
// ---------------------------------------------------------------------------
interface RunVerifyInput {
  piccHex: string;
  macHex: string;
  programId: string | undefined;
  /**
   * Which urlCodes to try when reconstructing the MAC input.  For the
   * url-coded route this is exactly one (the path param).  For the
   * catch-all route this is every program's urlCode — we accept the first
   * one whose MAC verifies under the matched card's session key.
   */
  candidateUrlCodes: string[];
}

async function runVerify(
  _req: Request,
  res: Response,
  input: RunVerifyInput,
): Promise<void> {
  const kp = getCardFieldKeyProvider();
  const match = await findCardByPicc({
    programId: input.programId,
    piccHex: input.piccHex,
    keyProvider: kp,
  });
  if (!match) {
    throw notFound(
      'card_not_found',
      'No card decrypted the PICC bytes — wrong key, revoked card, or bogus tap',
    );
  }

  let valid = false;
  try {
    // Reconstruct the MAC input the chip signed.  We don't know which
    // urlCode the chip's URL contained (it isn't carried in the API call),
    // so try each candidate until one matches.  Per AN14683 the MAC
    // covers the URL substring from host through `&m=` — different
    // urlCodes produce different inputs, so only the right one verifies.
    const { mac: macSessionKey } = deriveSessionKeys(
      match.sdmFileReadKey,
      match.uid,
      Buffer.from([
        match.counter & 0xff,
        (match.counter >> 8) & 0xff,
        (match.counter >> 16) & 0xff,
      ]),
    );
    for (const urlCode of input.candidateUrlCodes) {
      const fullUrl =
        `https://mobile.karta.cards/t/${urlCode}` +
        `?e=${input.piccHex.toUpperCase()}&m=${input.macHex.toUpperCase()}`;
      const macInput = extractSdmmacInput(fullUrl);
      if (verifySdmmac(macSessionKey, macInput, input.macHex)) {
        valid = true;
        break;
      }
    }
  } finally {
    match.sdmMetaReadKey.fill(0);
    match.sdmFileReadKey.fill(0);
  }

  if (!valid) {
    throw unauthorized('sun_invalid', 'SDMMAC mismatch — URL was tampered with');
  }

  // Atomic counter advance — replay defence.
  const advance = await prisma.card.updateMany({
    where: { id: match.cardId, lastReadCounter: { lt: match.counter } },
    data: { lastReadCounter: match.counter },
  });
  if (advance.count !== 1) {
    throw gone(
      'sun_counter_replay',
      `Counter ${match.counter} not greater than stored ${match.lastReadCounter} (replay)`,
    );
  }

  // Mint handoff IFF the card is in a state that allows provisioning.
  const config = getTapConfig();
  let handoff: string | null = null;
  let reason: string | null = null;
  if (match.cardStatus === 'ACTIVATED' || match.cardStatus === 'PROVISIONED') {
    handoff = signHandoff(
      {
        sub: match.cardId,
        purpose: 'provisioning',
        iss: 'tap',
        ttlSeconds: 30,
        ctx: { readCounter: match.counter },
      },
      config.TAP_HANDOFF_SECRET,
    );
  } else {
    reason = 'card_not_ready';
  }

  res.json({
    cardId: match.cardId,
    cardStatus: match.cardStatus,
    handoff,
    reason,
  });
}

export default router;
