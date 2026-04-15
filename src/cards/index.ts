// Cards module — registration + UID fingerprint.
// SUN verification lives in src/sun/, activation in src/activation/, PAN
// handling in src/vault/.

export { registerCard } from './register.service.js';
export type { RegisterCardInput, RegisterCardResult } from './register.service.js';
export { fingerprintUid } from './fingerprint.js';
