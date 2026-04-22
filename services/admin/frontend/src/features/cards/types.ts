import type { CredentialKind } from '../../utils/webauthn';

export interface ActivationSessionRow {
  id: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedDeviceLabel: string | null;
  createdAt: string;
}

export interface Card {
  id: string;
  cardRef: string;
  status: 'BLANK' | 'SHIPPED' | 'PERSONALISED' | 'ACTIVATED' | 'PROVISIONED' | 'SUSPENDED' | 'REVOKED';
  retailSaleStatus: 'SHIPPED' | 'SOLD' | null;
  retailSoldAt: string | null;
  chipSerial: string | null;
  programId: string | null;
  // currency is optional pending a Palisade Program.currency schema
  // addition (the GET /api/cards endpoint omits it today; UI cells
  // that render currency must guard for undefined).
  program: { id: string; name: string; currency?: string; programType?: string } | null;
  batchId: string | null;
  createdAt: string;
  vaultEntry?: { id: string; panLast4: string; panBin: string; cardholderName: string } | null;
  credentials: { id: string; kind: CredentialKind; deviceName: string | null; createdAt: string; lastUsedAt: string | null }[];
  activationSessions: ActivationSessionRow[];
}

export interface CardCredentialRow {
  id: string;
  credentialId: string;
  kind: 'PLATFORM' | 'CROSS_PLATFORM';
  transports: string[];
  deviceName: string | null;
  preregistered: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
