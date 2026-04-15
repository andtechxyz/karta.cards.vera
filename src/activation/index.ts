// Activation module — the SUN-tap → WebAuthn-registration chain that flips a
// PERSONALISED card to ACTIVATED.  See sun-tap.service.ts for the URL handler
// and begin/finish for the WebAuthn ceremony.

export { handleSunTap } from './sun-tap.service.js';
export type { HandleSunTapInput, HandleSunTapResult } from './sun-tap.service.js';
export { beginActivationRegistration } from './begin.service.js';
export { finishActivationRegistration } from './finish.service.js';
export type { FinishInput, FinishResult } from './finish.service.js';
