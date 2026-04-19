/**
 * Operation runner — dispatches to the per-op handler.
 *
 * Phase 1 stubs every op as NOT_IMPLEMENTED.  Phase 2 fills in real ops
 * (list_applets, install_pa, reset_pa_state) against the SCP03 driver.
 *
 * Handlers receive a `send` + `next` pair and drive the APDU dance:
 *   send({type:'apdu', hex}) → await next() → send another → ... →
 *   send({type:'complete' | 'error'})
 *
 * The runner itself has no SCP knowledge — it just routes to the handler
 * and updates the CardOpSession row on terminal states.
 */

import { prisma } from '@vera/db';
import type { WSMessage } from './messages.js';
import { isOperation, notImplemented } from '../operations/index.js';
import { Prisma } from '@prisma/client';

type CardOpSessionWithCard = Prisma.CardOpSessionGetPayload<{ include: { card: true } }>;

export interface OperationContext {
  session: CardOpSessionWithCard;
  send: (msg: WSMessage) => void;
  next: () => Promise<WSMessage>;
}

export async function runOperation(ctx: OperationContext): Promise<void> {
  const { session, send } = ctx;

  if (!isOperation(session.operation)) {
    send({ type: 'error', code: 'UNKNOWN_OP', message: session.operation });
    await markFailed(session.id, `unknown_op:${session.operation}`);
    return;
  }

  // Phase 1: every operation reports NOT_IMPLEMENTED.  Phase 2 will
  // replace this dispatch with actual handlers.
  //
  // TODO(phase-2): delegate to per-op handlers:
  //   list_applets   → operations/list-applets.ts
  //   install_pa     → operations/install-pa.ts
  //   reset_pa_state → operations/reset-pa-state.ts (no SCP03 needed)
  // The rest stay NOT_IMPLEMENTED until their respective phases.
  send(notImplemented(session.operation));
  await markFailed(session.id, 'not_implemented');
}

async function markFailed(sessionId: string, reason: string): Promise<void> {
  await prisma.cardOpSession.update({
    where: { id: sessionId },
    data: {
      phase: 'FAILED',
      failedAt: new Date(),
      failureReason: reason,
      // Prisma requires the explicit DbNull marker to erase a nullable
      // Json column (passing `null` is a type error).
      scpState: Prisma.DbNull,
    },
  }).catch(() => { /* best-effort */ });
}
