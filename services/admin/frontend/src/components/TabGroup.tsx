// Two-level tab navigation.  Primary tabs group features by domain
// (Identity, Ingest, Provisioning, Content, Activity); the secondary
// row shows the features inside the active group.  Both rows wrap on
// narrow viewports.

export interface SecondaryTab {
  id: string;
  label: string;
}

export interface PrimaryTab {
  id: string;
  label: string;
  children: SecondaryTab[];
}

export function TabGroup({
  tabs,
  primaryId,
  secondaryId,
  onChange,
}: {
  tabs: PrimaryTab[];
  primaryId: string;
  secondaryId: string;
  onChange: (primaryId: string, secondaryId: string) => void;
}) {
  const primary = tabs.find((t) => t.id === primaryId) ?? tabs[0];
  return (
    <div>
      <div className="tabs-primary" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === primary.id}
            className={`tab-primary ${t.id === primary.id ? 'active' : ''}`}
            onClick={() => {
              // Stay on the current secondary when the user re-clicks the
              // active primary; otherwise fall back to the first child of
              // the newly-selected primary group.
              if (t.id === primary.id) return;
              onChange(t.id, t.children[0].id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabs-secondary" role="tablist">
        {primary.children.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === secondaryId}
            className={`tab-secondary ${t.id === secondaryId ? 'active' : ''}`}
            onClick={() => onChange(primary.id, t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
