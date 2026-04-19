import { Router } from 'express';
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

// POST /api/tap/verify/:urlCode
//
// The mobile-app facing entry point for cardRef-less SUN URLs.  Given the
// raw SUN params the chip emits — `?e=<picc-hex>&m=<mac-hex>` — verify the
// tap is authentic and (if so) mint a 30s `provisioning` handoff token the
// app can swap at /api/provisioning/start.
//
// Phase 1 implementation: trial-decrypt PICC against every Card in the
// program until one matches.  Per-card key resolution happens via the
// existing per-card-key-encrypted-on-row path.  Phase 2 swaps the
// findCardByPicc internals for HSM-derived UDK lookup; the route shape +
// response contract don't change.
//
// Authentication is the SUN signature itself — no Cognito here.  Rate
// limiting at the express level guards against PICC enumeration.
//
// The chip's URL the mobile app receives:
//   https://mobile.karta.cards/t/<urlCode>?e=<picc>&m=<cmac>
// The mobile app parses urlCode + e + m and POSTs to:
//   POST https://tap.karta.cards/api/tap/verify/<urlCode>
//   body: { e: "<32 hex>", m: "<16 hex>" }

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_16 = /^[0-9a-fA-F]{16}$/;

const verifySchema = z.object({
  e: z.string().regex(HEX_32, 'e must be 32 hex chars (encrypted PICC)'),
  m: z.string().regex(HEX_16, 'm must be 16 hex chars (truncated SDM MAC)'),
});

const URL_CODE_RE = /^[a-z0-9]{2,8}$/;

const router: Router = Router();

router.post('/verify/:urlCode', validateBody(verifySchema), async (req, res) => {
  const urlCode = req.params.urlCode;
  if (!URL_CODE_RE.test(urlCode)) {
    throw badRequest('invalid_url_code', 'urlCode must be 2-8 chars [a-z0-9]');
  }
  const { e: piccHex, m: macHex } = req.body as { e: string; m: string };

  // 1. Resolve the program by its public urlCode.
  const program = await prisma.program.findUnique({
    where: { urlCode },
    select: { id: true, name: true },
  });
  if (!program) {
    throw notFound('program_not_found', `No program with urlCode "${urlCode}"`);
  }

  // 2. Trial-decrypt PICC across every Card in this program until tag=0xC7.
  const kp = getCardFieldKeyProvider();
  const match = await findCardByPicc({
    programId: program.id,
    piccHex,
    keyProvider: kp,
  });
  if (!match) {
    // Could be: card revoked, wrong urlCode for this card, totally bogus
    // PICC.  We can't tell them apart without leaking info — return a
    // single uninformative status.
    throw notFound(
      'card_not_found',
      `No card in program ${program.id} decrypted the PICC bytes`,
    );
  }

  let valid = false;
  try {
    // 3. Verify the truncated SDM MAC.  MAC input is the URL portion from
    //    the host through `&m=` — we reconstruct it to match what the chip
    //    signed.  This is the post-activation cardRef-less URL shape, so
    //    the host+path is fixed: mobile.karta.cards/t/<urlCode>.
    const fullUrl =
      `https://mobile.karta.cards/t/${urlCode}` +
      `?e=${piccHex.toUpperCase()}&m=${macHex.toUpperCase()}`;
    const macInput = extractSdmmacInput(fullUrl);
    const { mac: macSessionKey } = deriveSessionKeys(
      match.sdmFileReadKey,
      match.uid,
      // 3-byte LE counter — reconstruct from the int we pulled out of PICC.
      Buffer.from([
        match.counter & 0xff,
        (match.counter >> 8) & 0xff,
        (match.counter >> 16) & 0xff,
      ]),
    );
    valid = verifySdmmac(macSessionKey, macInput, macHex);
  } finally {
    match.sdmMetaReadKey.fill(0);
    match.sdmFileReadKey.fill(0);
  }

  if (!valid) {
    throw unauthorized('sun_invalid', 'SDMMAC mismatch — URL was tampered with');
  }

  // 4. Atomic counter advance — replay defence.
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

  // 5. Mint handoff (provisioning purpose) IFF the card is in a state that
  //    allows provisioning.  ACTIVATED/PROVISIONED → token; anything else
  //    → null + reason code.  The app uses the reason to render the right
  //    "what now" screen without us leaking which-state-we-are.
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
});

export default router;
