import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { formatDate } from '../../utils/format';
import { StatusChip } from '../../components/StatusChip';
import type { CardCredentialRow } from './types';

// Per-card panel — pre-register a FIDO credential, list existing
// credentials, delete pre-registered ones.
//
// Pre-registration is the perso-time path: during card personalisation the
// FIDO applet generates a credential on the chip; perso operators capture
// the credentialId + COSE public key and POST them here.  At activation
// time the SUN tap + the existing credential together flip the card to
// ACTIVATED — no runtime WebAuthn ceremony.

export function CardCredentialsPanel({
  cardRef,
  cardStatus,
  onChanged,
}: {
  cardRef: string;
  cardStatus: string;
  onChanged: () => Promise<void> | void;
}) {
  const [creds, setCreds] = useState<CardCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<CardCredentialRow[]>(`/cards/${cardRef}/credentials`);
      setCreds(rows);
      setErr(null);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [cardRef]);

  useEffect(() => {
    reload();
  }, [reload]);

  const hasPreregistered = creds.some((c) => c.preregistered);
  const canPreregister = cardStatus === 'SHIPPED' && !hasPreregistered;

  return (
    <div>
      <h4 style={{ margin: '0 0 8px 0' }}>Credentials</h4>
      {err && <p className="tag err">{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : creds.length === 0 ? (
        <p className="small">No credentials registered.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {creds.map((cr) => (
            <div
              key={cr.id}
              style={{
                border: '1px solid var(--edge)',
                borderRadius: 'var(--radius)',
                padding: 10,
              }}
            >
              <div className="row" style={{ marginBottom: 6 }}>
                <StatusChip
                  label={cr.preregistered ? 'Pre-registered' : 'User-registered'}
                  tone={cr.preregistered ? 'success' : 'info'}
                />
                <span className="small">
                  {cr.kind === 'PLATFORM' ? 'Face ID / Hello' : 'NFC'}
                </span>
              </div>
              <div className="mono small" style={{ wordBreak: 'break-all' }}>
                {cr.credentialId.slice(0, 40)}
                {cr.credentialId.length > 40 ? '…' : ''}
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                {cr.deviceName ?? '—'} · transports:{' '}
                {cr.transports.join(', ') || '—'}
              </div>
              <div className="small">
                Created {formatDate(cr.createdAt)}
                {cr.lastUsedAt ? ` · Last used ${formatDate(cr.lastUsedAt)}` : ''}
              </div>
              {cr.preregistered && (
                <div style={{ marginTop: 8 }}>
                  <button
                    className="btn ghost"
                    style={{ padding: '2px 8px', fontSize: 12 }}
                    onClick={async () => {
                      if (!confirm('Delete this pre-registered credential?')) return;
                      try {
                        await api.delete(`/cards/${cardRef}/credentials/${cr.id}`);
                        await reload();
                        await onChanged();
                      } catch (e) {
                        setErr(errorMsg(e));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canPreregister ? (
        <PreRegisterCredentialForm cardRef={cardRef} onCreated={async () => { await reload(); await onChanged(); }} />
      ) : hasPreregistered ? (
        <p className="small">
          Card already has a pre-registered credential — delete it above to inject a different one.
        </p>
      ) : (
        <p className="small">
          Card is <code>{cardStatus}</code> — pre-registration is only valid in <code>SHIPPED</code>.
        </p>
      )}
    </div>
  );
}

function PreRegisterCredentialForm({
  cardRef,
  onCreated,
}: {
  cardRef: string;
  onCreated: () => Promise<void> | void;
}) {
  const [credentialId, setCredentialId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [transports, setTransports] = useState('nfc');
  const [deviceName, setDeviceName] = useState('Pre-registered (perso)');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/cards/${cardRef}/credentials`, {
        credentialId: credentialId.trim(),
        publicKey: publicKey.trim(),
        transports: transports.split(',').map((s) => s.trim()).filter(Boolean),
        deviceName: deviceName || undefined,
      });
      setCredentialId('');
      setPublicKey('');
      await onCreated();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--edge)', borderRadius: 'var(--radius)' }}>
      <h4 style={{ marginTop: 0 }}>Pre-register FIDO credential</h4>
      <p className="small" style={{ marginTop: 0 }}>
        Captured by the perso tool from the FIDO applet on the chip.
        Both fields are base64url (no padding).  Card flips to ACTIVATED on
        the next tap — the runtime WebAuthn ceremony is skipped.
      </p>
      <label>Credential ID</label>
      <textarea
        value={credentialId}
        onChange={(e) => setCredentialId(e.target.value)}
        placeholder="base64url credentialId from FIDO makeCredential"
        rows={2}
        className="mono"
        style={{ width: '100%', fontSize: 12 }}
      />
      <label>Public key (COSE)</label>
      <textarea
        value={publicKey}
        onChange={(e) => setPublicKey(e.target.value)}
        placeholder="base64url COSE public key"
        rows={3}
        className="mono"
        style={{ width: '100%', fontSize: 12 }}
      />
      <label>Transports (comma-separated)</label>
      <input
        value={transports}
        onChange={(e) => setTransports(e.target.value)}
        placeholder="nfc"
        className="mono"
      />
      <label>Device label (optional)</label>
      <input
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
        placeholder="Pre-registered (perso)"
      />
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      <div style={{ marginTop: 8 }}>
        <button
          className="btn primary"
          disabled={busy || !credentialId.trim() || !publicKey.trim()}
          onClick={submit}
        >
          {busy ? 'Saving…' : 'Pre-register'}
        </button>
      </div>
    </div>
  );
}
