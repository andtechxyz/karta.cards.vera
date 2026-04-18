import { useState } from 'react';
import { clearAuthToken, getAuthToken } from '../utils/api';
import { Login } from '../auth/Login';
import { TabGroup, type PrimaryTab } from '../components/TabGroup';

import { FinancialInstitutionsPage } from '../features/financial-institutions/Page';
import { ProgramsPage } from '../features/programs/Page';
import { CardsPage } from '../features/cards/Page';
import { VaultPage } from '../features/vault/Page';
import { BatchesPage } from '../features/batches/Page';
import { EmbossingTemplatesPage } from '../features/embossing-templates/Page';
import { EmbossingBatchesPage } from '../features/embossing-batches/Page';
import { ChipProfilesPage } from '../features/chip-profiles/Page';
import { KeyMgmtPage } from '../features/key-mgmt/Page';
import { ProvMonitorPage } from '../features/prov-monitor/Page';
import { MicrositesPage } from '../features/microsites/Page';
import { TransactionsPage } from '../features/transactions/Page';
import { AuditPage } from '../features/audit/Page';

// Admin UI — read-only view of cards, vault entries, transactions, and the
// vault audit tail.
//
// Cards are NOT created from this page in the production lifecycle —
// Palisade's provisioning-agent calls POST /api/cards/register after data-
// prep + perso.  Activation is entirely cardholder-driven: tap the card →
// SDM URL fires → /activate?session=<token>.  Admin sees the resulting
// state but cannot mint sessions or links itself.

const TABS: PrimaryTab[] = [
  {
    id: 'identity',
    label: 'Identity',
    children: [
      { id: 'financialInstitutions', label: 'Financial Institutions' },
      { id: 'programs', label: 'Programs' },
      { id: 'cards', label: 'Cards' },
      { id: 'vault', label: 'Vault' },
    ],
  },
  {
    id: 'ingest',
    label: 'Ingest',
    children: [
      { id: 'batches', label: 'Batches' },
      { id: 'embossingTemplates', label: 'Embossing Templates' },
      { id: 'embossingBatches', label: 'Embossing Batches' },
    ],
  },
  {
    id: 'provisioning',
    label: 'Provisioning',
    children: [
      { id: 'chipProfiles', label: 'Chip Profiles' },
      { id: 'keyMgmt', label: 'Key Management' },
      { id: 'provMonitor', label: 'Provisioning Monitor' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    children: [{ id: 'microsites', label: 'Microsites' }],
  },
  {
    id: 'activity',
    label: 'Activity',
    children: [
      { id: 'transactions', label: 'Transactions' },
      { id: 'audit', label: 'Audit' },
    ],
  },
];

const SECONDARY_COMPONENTS: Record<string, () => JSX.Element> = {
  financialInstitutions: FinancialInstitutionsPage,
  programs: ProgramsPage,
  cards: CardsPage,
  vault: VaultPage,
  batches: BatchesPage,
  embossingTemplates: EmbossingTemplatesPage,
  embossingBatches: EmbossingBatchesPage,
  chipProfiles: ChipProfilesPage,
  keyMgmt: KeyMgmtPage,
  provMonitor: ProvMonitorPage,
  microsites: MicrositesPage,
  transactions: TransactionsPage,
  audit: AuditPage,
};

export default function Admin() {
  const [authToken, setAuthToken] = useState(getAuthToken() || '');
  const [primary, setPrimary] = useState<string>('identity');
  const [secondary, setSecondary] = useState<string>('cards');

  if (!authToken) {
    return <Login onAuth={setAuthToken} />;
  }

  const ActivePage = SECONDARY_COMPONENTS[secondary] ?? CardsPage;

  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>karta.cards Admin</h1>
        <button
          className="btn ghost"
          onClick={() => {
            clearAuthToken();
            setAuthToken('');
          }}
        >
          Logout
        </button>
      </div>
      <p className="small">Cards, vault, WebAuthn credentials, transactions, audit.</p>
      <TabGroup
        tabs={TABS}
        primaryId={primary}
        secondaryId={secondary}
        onChange={(p, s) => {
          setPrimary(p);
          setSecondary(s);
        }}
      />
      <ActivePage />
    </div>
  );
}
