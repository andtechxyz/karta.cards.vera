// Bright, high-contrast status pill.  The `tone` prop drives the colour
// so callers don't have to know which status string maps to which colour
// family — see statusToneFor() below for the canonical map.

export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`chip ${tone}`}>{label}</span>;
}

/**
 * Canonical status → tone map, covering every status string the backend
 * emits across Card, Program, PartnerCredential, EmbossingBatch, AuditLog,
 * Transaction, ProvisioningSession, and FinancialInstitution.  Unknown
 * values fall back to 'neutral'.
 */
export function statusToneFor(status: string): Tone {
  switch (status) {
    case 'ACTIVATED':
    case 'ACTIVE':
    case 'COMPLETE':
    case 'COMPLETED':
    case 'PROCESSED':
    case 'SUCCESS':
    case 'SOLD':
      return 'success';
    case 'PERSONALISED':
    case 'PENDING':
    case 'PROCESSING':
    case 'DATA_PREP':
    case 'PERSO':
    case 'SHIPPED':
      return 'warn';
    case 'FAILED':
    case 'FAILURE':
    case 'EXPIRED':
    case 'SUSPENDED':
    case 'REVOKED':
      return 'danger';
    case 'PROVISIONED':
    case 'RECEIVED':
      return 'info';
    case 'BLANK':
    default:
      return 'neutral';
  }
}
