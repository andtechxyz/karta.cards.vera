export {
  lookupCard,
  incrementAtc,
  listWebAuthnCredentials,
  getWebAuthnCredentialByCredentialId,
  createWebAuthnCredential,
  updateWebAuthnCredentialCounter,
  createRegistrationChallenge,
  getRegistrationChallenge,
  deleteRegistrationChallenge,
  PalisadeClientError,
} from './palisade-client.js';
export type {
  CardState,
  WebAuthnCredential,
  CreateCredInput,
  RegistrationChallenge,
  CreateChallengeInput,
  PalisadeClientOptions,
} from './palisade-client.js';
