import { useState } from 'react';

// Label + monospace value + copy button.  Reused by FreshCredentialPanel
// and anywhere an admin needs to copy an opaque identifier.

export function CopyableField({
  label,
  value,
  sensitive = false,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable — user can still select and copy manually
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small" style={{ color: sensitive ? 'var(--warn)' : 'var(--mute)' }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 4 }}>
        <code
          className="mono"
          style={{
            flex: 1,
            background: 'var(--panel-2)',
            border: '1px solid var(--edge)',
            borderRadius: 'var(--radius)',
            padding: '8px 10px',
            wordBreak: 'break-all',
            fontSize: 12,
          }}
        >
          {value}
        </code>
        <button className="btn ghost" onClick={copy} style={{ minHeight: 0, padding: '4px 10px' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
