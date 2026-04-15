import { TransactionStatus } from '@prisma/client';

// -----------------------------------------------------------------------------
// Transaction state machine.
//
// Enforces valid transitions so the post-auth orchestration can't emit
// COMPLETED after FAILED on retry, or loop backwards after a terminal state.
//
// Happy path:
//   PENDING
//    → AUTHN_STARTED
//    → AUTHN_COMPLETE
//    → ARQC_VALID
//    → VAULT_RETRIEVED
//    → STRIPE_CHARGED      (provider-neutral despite the name)
//    → COMPLETED           (terminal)
//
// Branches:
//   any → FAILED    (terminal)
//   any → EXPIRED   (terminal; scheduled job or on access after expiresAt)
// -----------------------------------------------------------------------------

const TERMINAL: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.COMPLETED,
  TransactionStatus.FAILED,
  TransactionStatus.EXPIRED,
]);

const ALLOWED: Readonly<Record<TransactionStatus, ReadonlySet<TransactionStatus>>> = {
  [TransactionStatus.PENDING]: new Set([
    TransactionStatus.AUTHN_STARTED,
    TransactionStatus.FAILED,
    TransactionStatus.EXPIRED,
  ]),
  [TransactionStatus.AUTHN_STARTED]: new Set([
    TransactionStatus.AUTHN_COMPLETE,
    TransactionStatus.FAILED,
    TransactionStatus.EXPIRED,
  ]),
  [TransactionStatus.AUTHN_COMPLETE]: new Set([
    TransactionStatus.ARQC_VALID,
    TransactionStatus.FAILED,
    TransactionStatus.EXPIRED,
  ]),
  [TransactionStatus.ARQC_VALID]: new Set([
    TransactionStatus.VAULT_RETRIEVED,
    TransactionStatus.FAILED,
    TransactionStatus.EXPIRED,
  ]),
  [TransactionStatus.VAULT_RETRIEVED]: new Set([
    TransactionStatus.STRIPE_CHARGED,
    TransactionStatus.FAILED,
    TransactionStatus.EXPIRED,
  ]),
  [TransactionStatus.STRIPE_CHARGED]: new Set([
    TransactionStatus.COMPLETED,
    TransactionStatus.FAILED,
  ]),
  [TransactionStatus.COMPLETED]: new Set<TransactionStatus>(),
  [TransactionStatus.FAILED]: new Set<TransactionStatus>(),
  [TransactionStatus.EXPIRED]: new Set<TransactionStatus>(),
};

export function isTerminal(s: TransactionStatus): boolean {
  return TERMINAL.has(s);
}

export function canTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  return ALLOWED[from].has(to);
}

export function assertTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal transaction transition: ${from} → ${to}. Transaction may already be terminal.`,
    );
  }
}
