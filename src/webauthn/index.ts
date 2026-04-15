export {
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
} from './webauthn.service.js';
export type {
  BeginRegistrationInput,
  FinishRegistrationInput,
  BeginAuthenticationInput,
  FinishAuthenticationInput,
  FinishAuthenticationResult,
} from './webauthn.service.js';
export {
  buildNfcCardRegistrationOptions,
  buildPlatformRegistrationOptions,
  buildAuthenticationOptions,
} from './config.js';
