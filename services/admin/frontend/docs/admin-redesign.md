# Admin UI redesign

Status: proposal + implementation (phase 1 — pure frontend refactor, no backend changes).

## Problems the redesign addresses

1. **Tables wrap.** Card refs (28+ chars), KMS key ARNs, PAN SHAs, and the
   program selector all compete for width. At 1280px the Cards table
   wraps to 3–4 lines per row and becomes unreadable.
2. **Inline row expansion** uses a light background (`#fafafa`) that
   visually shatters the dark panel and breaks row striping. You lose
   the highlighted card row while viewing its credentials.
3. **Tabs overflow at <1200px.** 13 flat tabs in a single `<div class="tabs">`
   horizontally scroll offscreen on laptops.
4. **No search / filter.** Every table renders its full list. Finding one
   card among 500 means ⌘-F in the browser.
5. **Status chips are tiny and muted.** `PERSONALISED`, `ACTIVATED`,
   `PROVISIONED`, `SUSPENDED`, and `REVOKED` all share nearly-identical
   pastel borders — impossible to scan.
6. **Single 3919-line `Admin.tsx`.** Every feature lives in one file.
   Merge conflicts are routine; reading flow is painful.

## Reference — current state (ASCII mockups)

(Full-bitmap screenshots require a live browser session + Cognito
credentials that this refactor agent doesn't have. The sketches below
reflect the actual DOM shape; anyone with the admin URL can diff
against `manage.karta.cards` directly.)

### Current: Cards tab at 1280px

```
┌──────────────────────────────────────────────────────────────────────────┐
│ karta.cards Admin                                              [Logout]  │
│ Cards, vault, WebAuthn credentials, transactions, audit.                 │
│ [Financial… │Cards│Vault│Programs│Transactions│Audit│Chip P…│Key…│Batch… │ <— 13 tabs overflow
├──────────────────────────────────────────────────────────────────────────┤
│ Cards                                                                    │
│                                                                          │
│ ▸ │ card_8f4a2c…  │ [PERSONALISED]│ — │ •••• 4242 │ [Karta Pla… ▾]│ …   │
│   │ (wraps)       │               │   │           │ (wraps again) │      │
│ ▸ │ card_1e9b7…  │ [ACTIVATED]   │ — │ •••• 0031 │ [Karta Aus… ▾]│ …   │
│                                                                          │
│ (expanded)                                                               │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ (panel background flips to light grey — visually breaks striping)    │ │
│ │ Credentials                                                          │ │
│ │ ID │ Source │ Kind │ Transports │ Device │ Created │ Last used │    │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### Current: Programs tab status column

```
┌────────────────────────────────────────┐
│ ID           Name       Type   Rules   │
│ prog_plat_1  Platinum   Cred.  2 rules │  <— "[PERSONALISED]" chip on cards tab
│ prog_ret_2   Gift card  Ret.   1 rule  │     is same visual weight as any body
└────────────────────────────────────────┘     text — low contrast, no colour
```

## Proposed layout

### 2-level tabs (primary + secondary)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ karta.cards Admin                                              [Logout]  │
├──────────────────────────────────────────────────────────────────────────┤
│  Identity · Ingest · Provisioning · Content · Activity                   │  <— 5 primary tabs
├──────────────────────────────────────────────────────────────────────────┤
│  Financial Institutions   Programs   Cards   Vault                       │  <— secondary (under "Identity")
├──────────────────────────────────────────────────────────────────────────┤
```

Grouping:

| Primary       | Secondary tabs                                                  |
|---------------|-----------------------------------------------------------------|
| Identity      | Financial Institutions · Programs · Cards · Vault               |
| Ingest        | Batches (perso CSV) · Embossing Templates · Embossing Batches   |
| Provisioning  | Chip Profiles · Key Management · Provisioning Monitor           |
| Content       | Microsites                                                      |
| Activity      | Transactions · Audit                                            |

At <1200px the primary row stays in place (5 items fit) and the secondary
row wraps.

### Proposed: Cards table with fixed widths + drawer

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Cards                                                                    │
│ [🔍 Search card ref / PAN last 4 …]   Filter: [All statuses ▾]          │
│                                                                          │
│ Card ref        │ Status        │ Vault   │ Program     │ Activation     │
│─────────────────┼───────────────┼─────────┼─────────────┼────────────────│
│ card_8f4a2c…📋 │ [ACTIVATED]   │ ••4242  │ Platinum    │ ✓ Hello world  │
│ card_1e9b7d…📋 │ [PERSONAL…]   │ ••0031  │ Gift Card   │ awaiting tap   │  <— fixed widths
│ card_7c3d5e…📋 │ [PROVIS…]     │ ••8821  │ Platinum    │ tap pending    │  <— ellipsis + copy icon
│                                                                          │
│ (click row ⇒ drawer slides in from the right; row stays highlighted)     │
└──────────────────────────────────────────────────────────────────────────┘

(drawer — 420px wide, slides over)
                                                ┌─────────────────────────┐
                                                │ card_8f4a2c_20260115    │
                                                │ [✕ close]               │
                                                ├─────────────────────────┤
                                                │ Status: [ACTIVATED]     │
                                                │ Created: 2026-01-15     │
                                                │                         │
                                                │ Credentials (2)         │
                                                │ ─ Face ID / Hello       │
                                                │ ─ NFC (pre-registered)  │
                                                │   [Delete]              │
                                                │                         │
                                                │ [+ Pre-register FIDO]   │
                                                └─────────────────────────┘
```

### Proposed: status chips — bright, high-contrast

```
[ACTIVATED]   — solid green (#22c55e) text on green-tinted background
[PERSONALISED] — solid amber
[PROVISIONED] — solid blue
[SUSPENDED]   — solid orange
[REVOKED]     — solid red
[BLANK]       — neutral grey
```

One chip style per state, enforced via a single `<StatusChip>` component
with a `status → tone` map.

## Architecture — file split

Before (one file):

```
src/pages/Admin.tsx  (3919 lines)
```

After:

```
src/
├── pages/
│   └── Admin.tsx             (shell: 5-tab nav + auth gate)
├── auth/
│   └── Login.tsx             (all Cognito flows)
├── components/
│   ├── Table.tsx             (sortable, filterable, fixed columns, copy-on-click)
│   ├── StatusChip.tsx        (bright palette with status → tone map)
│   ├── Drawer.tsx            (right-edge panel, focus-trap, ESC-to-close)
│   ├── TabGroup.tsx          (2-level primary/secondary)
│   └── CopyableField.tsx     (label + mono value + copy button — reused)
├── hooks/
│   └── useCards.ts
└── features/
    ├── financial-institutions/{Page,Form,PartnerCredentials,SftpAccess}.tsx
    ├── programs/{Page,Form,RuleEditor}.tsx
    ├── cards/{Page,Drawer,CredentialsPanel,PreRegisterForm}.tsx
    ├── vault/Page.tsx
    ├── chip-profiles/Page.tsx
    ├── key-mgmt/{Page,Form}.tsx
    ├── prov-monitor/Page.tsx
    ├── batches/Page.tsx
    ├── embossing-templates/Page.tsx
    ├── embossing-batches/{Page,StatusCell}.tsx
    ├── microsites/Page.tsx
    ├── transactions/Page.tsx
    └── audit/Page.tsx
```

Backend contracts are untouched — every `api.get/post/patch/delete` URL
is preserved verbatim. This is a pure frontend decomposition.

## What's NOT in this PR

- No new endpoints. Search/filter is client-side only (data is already
  fully loaded); server-side pagination is a follow-up.
- No routing per feature. Tabs remain a single `/admin` route with
  component state — matches the current behaviour so browser back/forward
  doesn't regress.
- Transactions/Audit still auto-poll at 5 s, Embossing Batches at 10 s —
  preserved as-is.

## Shared-component contracts

```ts
// components/Table.tsx
interface Column<T> {
  key: string;
  header: string;
  width?: string;             // e.g. "160px" — enables fixed-width table-layout
  mono?: boolean;             // ui-monospace font
  copyable?: (row: T) => string | null;  // clicking cell copies the returned value
  ellipsis?: boolean;         // truncate with title attr for hover-reveal
  render: (row: T) => React.ReactNode;
  sort?: (row: T) => string | number;
}
interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeRowKey?: string | null;
  searchPlaceholder?: string;
  searchMatch?: (row: T, query: string) => boolean;
  empty?: React.ReactNode;
}

// components/StatusChip.tsx
type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';
export function StatusChip({ label, tone }: { label: string; tone: Tone });

// components/Drawer.tsx
export function Drawer({ open, onClose, title, children }: {...});

// components/TabGroup.tsx
interface Secondary { id: string; label: string; }
interface Primary { id: string; label: string; children: Secondary[]; }
export function TabGroup({ tabs, primary, secondary, onChange }: {...});
```
