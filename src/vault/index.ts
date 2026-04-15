// Public surface of the vault module.
//
// External code imports from this file only.  Adding new capabilities
// (aliases, reactors, webhooks, metadata search, etc.) means:
//   1. a new service file inside src/vault/ (or a nested directory),
//   2. a new export here,
//   3. a new route file in src/routes/vault/ wiring it up.
// The rest of the app doesn't change.

export type {
  CardMetadata,
  StoreInput,
  StoreResult,
  MintTokenInput,
  MintTokenResult,
  DecryptedCard,
} from './types.js';

export { storeCard, listCards, getCardMetadata } from './store.service.js';
export { mintRetrievalToken, consumeRetrievalToken } from './retrieval.service.js';
export type { ConsumeContext, ConsumeResult } from './retrieval.service.js';
export { forwardViaVault } from './proxy.service.js';
export type { ProxyInput, ProxyResult } from './proxy.service.js';
export { startAuditSubscriber, listAuditEvents } from './audit.service.js';
export { vaultEvents } from './events.js';
export type { VaultEvent } from './events.js';
export { luhnValid, fingerprintPan } from './fingerprint.js';
// Exposed so modules that store non-PAN secrets under the same vault key
// versioning (UID, SDM keys) can encrypt/decrypt without reaching past the
// barrel.  Same AES-256-GCM envelope; same KeyProvider-backed rotation path.
export { encrypt, decrypt } from './encryption.js';
