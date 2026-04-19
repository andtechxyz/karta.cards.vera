import { useEffect, useMemo, useState } from 'react';
import {
  clearAuthToken,
  fetchCapabilities,
  getAuthToken,
  errorMsg,
  type Capabilities,
} from '../utils/api';
import { Login } from '../auth/Login';
import { TabGroup, type PrimaryTab, type SecondaryTab } from '../components/TabGroup';

import { FinancialInstitutionsPage } from '../features/financial-institutions/Page';
import { ProgramsPage } from '../features/programs/Page';
import { CardsPage } from '../features/cards/Page';
import { VaultPage } from '../features/vault/Page';
import { TokenisationProgramsPage } from '../features/tokenisation-programs/Page';
import { BatchesPage } from '../features/batches/Page';
import { EmbossingTemplatesPage } from '../features/embossing-templates/Page';
import { EmbossingBatchesPage } from '../features/embossing-batches/Page';
import { ChipProfilesPage } from '../features/chip-profiles/Page';
import { IssuerProfilesPage } from '../features/issuer-profiles/Page';
import { KeyMgmtPage } from '../features/key-mgmt/Page';
import { ProvMonitorPage } from '../features/prov-monitor/Page';
import { MicrositesPage } from '../features/microsites/Page';
import { TransactionsPage } from '../features/transactions/Page';
import { AuditPage } from '../features/audit/Page';

// Admin UI — shared SPA across Vera + Palisade, gated by capability flags
// fetched from Vera's /api/capabilities endpoint (no auth required).  Tabs
// whose backend is disabled are hidden entirely; groups with no children
// after filtering drop off the primary row.

type Backend = 'vera' | 'palisade';

interface TaggedSecondary extends SecondaryTab {
  backend: Backend;
}

interface TaggedPrimary {
  id: string;
  label: string;
  children: TaggedSecondary[];
}

const TAB_DEFS: TaggedPrimary[] = [
  {
    id: 'identity',
    label: 'Identity',
    children: [
      { id: 'financialInstitutions', label: 'Financial Institutions', backend: 'palisade' },
      { id: 'programs', label: 'Programs', backend: 'palisade' },
      { id: 'cards', label: 'Cards', backend: 'palisade' },
      { id: 'vault', label: 'Vault', backend: 'vera' },
      { id: 'tokenisationPrograms', label: 'Tokenisation Programs', backend: 'vera' },
    ],
  },
  {
    id: 'ingest',
    label: 'Ingest',
    children: [
      { id: 'batches', label: 'Batches', backend: 'palisade' },
      { id: 'embossingTemplates', label: 'Embossing Templates', backend: 'palisade' },
      { id: 'embossingBatches', label: 'Embossing Batches', backend: 'palisade' },
    ],
  },
  {
    id: 'provisioning',
    label: 'Provisioning',
    children: [
      { id: 'chipProfiles', label: 'Chip Profiles', backend: 'palisade' },
      { id: 'keyMgmt', label: 'Key Management', backend: 'palisade' },
      { id: 'provMonitor', label: 'Provisioning Monitor', backend: 'palisade' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    children: [{ id: 'microsites', label: 'Microsites', backend: 'palisade' }],
  },
  {
    id: 'activity',
    label: 'Activity',
    children: [
      { id: 'transactions', label: 'Transactions', backend: 'vera' },
      { id: 'audit', label: 'Audit', backend: 'vera' },
    ],
  },
];

const SECONDARY_COMPONENTS: Record<string, () => JSX.Element> = {
  financialInstitutions: FinancialInstitutionsPage,
  programs: ProgramsPage,
  cards: CardsPage,
  vault: VaultPage,
  tokenisationPrograms: TokenisationProgramsPage,
  batches: BatchesPage,
  embossingTemplates: EmbossingTemplatesPage,
  embossingBatches: EmbossingBatchesPage,
  chipProfiles: ChipProfilesPage,
  issuerProfiles: IssuerProfilesPage,
  keyMgmt: KeyMgmtPage,
  provMonitor: ProvMonitorPage,
  microsites: MicrositesPage,
  transactions: TransactionsPage,
  audit: AuditPage,
};

function filterTabs(caps: Capabilities, defs: TaggedPrimary[]): PrimaryTab[] {
  return defs
    .map((group) => ({
      id: group.id,
      label: group.label,
      children: group.children
        .filter((s) => (s.backend === 'vera' ? caps.hasVera : caps.hasPalisade))
        .map(({ backend: _backend, ...rest }) => rest),
    }))
    .filter((g) => g.children.length > 0);
}

export default function Admin() {
  const [authToken, setAuthToken] = useState(getAuthToken() || '');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsErr, setCapsErr] = useState<string | null>(null);
  const [primary, setPrimary] = useState<string>('');
  const [secondary, setSecondary] = useState<string>('');

  useEffect(() => {
    fetchCapabilities()
      .then(setCaps)
      .catch((e) => setCapsErr(errorMsg(e)));
  }, []);

  const tabs = useMemo(() => (caps ? filterTabs(caps, TAB_DEFS) : []), [caps]);

  // Seed the initial tab selection once caps arrive.  Re-seed if the current
  // selection falls outside the filtered set (e.g. on logout + re-login with
  // different capabilities).
  useEffect(() => {
    if (!tabs.length) return;
    const primaryStillValid = tabs.some((g) => g.id === primary);
    if (!primaryStillValid) {
      setPrimary(tabs[0].id);
      setSecondary(tabs[0].children[0].id);
      return;
    }
    const group = tabs.find((g) => g.id === primary)!;
    if (!group.children.some((s) => s.id === secondary)) {
      setSecondary(group.children[0].id);
    }
  }, [tabs, primary, secondary]);

  if (capsErr) {
    return (
      <div className="page">
        <p style={{ color: '#e74c3c' }}>Failed to load admin configuration: {capsErr}</p>
      </div>
    );
  }
  if (!caps) {
    return (
      <div className="page">
        <p className="small">Loading…</p>
      </div>
    );
  }
  if (!authToken) {
    return <Login onAuth={setAuthToken} />;
  }

  const ActivePage = SECONDARY_COMPONENTS[secondary];

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
        tabs={tabs}
        primaryId={primary}
        secondaryId={secondary}
        onChange={(p, s) => {
          setPrimary(p);
          setSecondary(s);
        }}
      />
      {ActivePage ? <ActivePage /> : null}
    </div>
  );
}
