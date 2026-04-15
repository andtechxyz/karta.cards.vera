import { EventEmitter } from 'node:events';

// -----------------------------------------------------------------------------
// VaultEventBus — the hook point for future cross-cutting concerns.
//
// Current subscribers: AuditService (writes VaultAccessLog rows).
// Future subscribers (no vault-core changes needed):
//   - Webhook dispatcher
//   - Analytics / telemetry
//   - Admin real-time feed
//   - Alias generator (when an alias module is added)
//
// Kept in-process + synchronous on purpose.  If we ever need cross-process
// fanout, swap the body of this module for a Redis pub/sub without changing
// any caller.
// -----------------------------------------------------------------------------

export type VaultEvent =
  | {
      type: 'CREATE';
      vaultEntryId: string;
      actor: string;
      purpose: string;
      ip?: string;
      ua?: string;
    }
  | {
      type: 'DUPLICATE_REJECTED';
      existingVaultEntryId: string;
      actor: string;
      purpose: string;
      ip?: string;
      ua?: string;
    }
  | {
      type: 'TOKEN_MINTED';
      vaultEntryId: string;
      retrievalTokenId: string;
      transactionId?: string;
      actor: string;
      purpose: string;
      ip?: string;
      ua?: string;
    }
  | {
      type: 'TOKEN_CONSUMED';
      vaultEntryId: string;
      retrievalTokenId: string;
      transactionId?: string;
      actor: string;
      purpose: string;
      ip?: string;
      ua?: string;
      success: boolean;
      errorMessage?: string;
    }
  | {
      type: 'PROXY_FORWARDED';
      vaultEntryId: string;
      retrievalTokenId: string;
      destination: string;
      actor: string;
      purpose: string;
      ip?: string;
      ua?: string;
      success: boolean;
      errorMessage?: string;
    }
  | {
      type: 'PROVIDER_TOKENISED';
      vaultEntryId: string;
      retrievalTokenId: string;
      providerName: string;
      transactionId?: string;
      actor: string;
      purpose: string;
      success: boolean;
      errorMessage?: string;
    };

export class VaultEventBus {
  private emitter = new EventEmitter();

  emit(event: VaultEvent): void {
    this.emitter.emit('vault', event);
  }

  subscribe(handler: (e: VaultEvent) => void | Promise<void>): () => void {
    const listener = (e: VaultEvent) => {
      try {
        const r = handler(e);
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[vault-event-subscriber]', err);
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[vault-event-subscriber]', err);
      }
    };
    this.emitter.on('vault', listener);
    return () => this.emitter.off('vault', listener);
  }
}

// Single process-wide bus.
export const vaultEvents = new VaultEventBus();
