import { prisma } from '../db/prisma.js';
import { vaultEvents, type VaultEvent } from './events.js';

// -----------------------------------------------------------------------------
// Audit subscriber.  Writes one VaultAccessLog row per VaultEvent.
//
// Nothing vault-side happens without an audit row, but audit writes are
// best-effort from the event bus (subscribers catch their own errors) so a
// DB hiccup in audit doesn't fail a vault operation.  This matches the
// Basis-Theory pattern: audit is observational, not in-path.
// -----------------------------------------------------------------------------

function normaliseEvent(e: VaultEvent): {
  eventType: VaultEvent['type'];
  result: 'SUCCESS' | 'FAILURE';
  vaultEntryId?: string;
  retrievalTokenId?: string;
  transactionId?: string;
  actor: string;
  purpose: string;
  ip?: string;
  ua?: string;
  errorMessage?: string;
} {
  switch (e.type) {
    case 'CREATE':
      return {
        eventType: e.type,
        result: 'SUCCESS',
        vaultEntryId: e.vaultEntryId,
        actor: e.actor,
        purpose: e.purpose,
        ip: e.ip,
        ua: e.ua,
      };
    case 'DUPLICATE_REJECTED':
      return {
        eventType: e.type,
        result: 'FAILURE',
        vaultEntryId: e.existingVaultEntryId,
        actor: e.actor,
        purpose: e.purpose,
        ip: e.ip,
        ua: e.ua,
      };
    case 'TOKEN_MINTED':
      return {
        eventType: e.type,
        result: 'SUCCESS',
        vaultEntryId: e.vaultEntryId,
        retrievalTokenId: e.retrievalTokenId,
        transactionId: e.transactionId,
        actor: e.actor,
        purpose: e.purpose,
        ip: e.ip,
        ua: e.ua,
      };
    case 'TOKEN_CONSUMED':
    case 'PROXY_FORWARDED':
    case 'PROVIDER_TOKENISED':
      return {
        eventType: e.type,
        result: e.success ? 'SUCCESS' : 'FAILURE',
        vaultEntryId: e.vaultEntryId,
        retrievalTokenId: e.retrievalTokenId,
        transactionId: 'transactionId' in e ? e.transactionId : undefined,
        actor: e.actor,
        purpose: e.purpose,
        ip: 'ip' in e ? e.ip : undefined,
        ua: 'ua' in e ? e.ua : undefined,
        errorMessage: e.errorMessage,
      };
  }
}

export function startAuditSubscriber(): () => void {
  return vaultEvents.subscribe(async (event) => {
    const norm = normaliseEvent(event);
    await prisma.vaultAccessLog.create({
      data: {
        eventType: norm.eventType,
        result: norm.result,
        vaultEntryId: norm.vaultEntryId,
        retrievalTokenId: norm.retrievalTokenId,
        transactionId: norm.transactionId,
        actor: norm.actor,
        purpose: norm.purpose,
        ipAddress: norm.ip,
        userAgent: norm.ua,
        errorMessage: norm.errorMessage,
      },
    });
  });
}

/** Paginated read for the admin Audit tab. */
export async function listAuditEvents(limit = 100, offset = 0) {
  return prisma.vaultAccessLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
    skip: offset,
    include: {
      vaultEntry: { select: { panLast4: true, panBin: true, cardholderName: true } },
    },
  });
}
