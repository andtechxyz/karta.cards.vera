export {
  lookupCard,
  incrementAtc,
  listWebAuthnCredentials,
  getWebAuthnCredentialByCredentialId,
  createWebAuthnCredential,
  updateWebAuthnCredentialCounter,
  PalisadeClientError,
} from './palisade-client.js';
export type {
  CardState,
  WebAuthnCredential,
  CreateCredInput,
  PalisadeClientOptions,
} from './palisade-client.js';
