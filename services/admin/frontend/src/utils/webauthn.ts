// Admin displays credential kinds read-only — no ceremonies run here.
// Registration happens on the cardholder's device via the activation or
// customer-payment flows.

export type CredentialKind = 'PLATFORM' | 'CROSS_PLATFORM';

/** Runtime array of every CredentialKind — for UI loops that need one row per kind. */
export const CREDENTIAL_KINDS: readonly CredentialKind[] = ['PLATFORM', 'CROSS_PLATFORM'] as const;
