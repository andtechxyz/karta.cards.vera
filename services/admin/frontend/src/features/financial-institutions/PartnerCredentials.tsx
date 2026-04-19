import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { CopyableField } from '../../components/CopyableField';
import { StatusChip, statusToneFor } from '../../components/StatusChip';

// --- Partner Credentials (per-FI) -------------------------------------------
//
// Lives inside FinancialInstitutionForm when editing an existing FI.  Lists
// existing credentials, lets admins mint new ones (secret shown ONCE), and
// revoke active ones.  The backend surfaces `secretHash` + `salt` in the
// creation response so partners have everything they need to sign HMACs
// without extra handshakes.

interface PartnerCredentialRow {
  id: string;
  keyId: string;
  description: string | null;
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdBy: string;
  createdAt: string;
}

interface NewCredentialResult {
  id: string;
  keyId: string;
  secret: string;
  secretHash: string;
  salt: string;
}

export function PartnerCredentialsSection({ fiId }: { fiId: string }) {
  const [rows, setRows] = useState<PartnerCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewCredentialResult | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get<PartnerCredentialRow[]>(
        `/admin/financial-institutions/${fiId}/credentials`,
      );
      setRows(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [fiId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (newDescription.trim()) body.description = newDescription.trim();
      const result = await api.post<NewCredentialResult>(
        `/admin/financial-institutions/${fiId}/credentials`,
        body,
      );
      setFresh(result);
      setCreating(false);
      setNewDescription('');
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: PartnerCredentialRow) => {
    const reason = window.prompt(
      `Revoke credential "${row.keyId}"?  Reason (optional):`,
      '',
    );
    if (reason === null) return;
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (reason.trim()) body.reason = reason.trim();
      await api.post(
        `/admin/financial-institutions/${fiId}/credentials/${row.id}/revoke`,
        body,
      );
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  return (
    <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--edge)' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Partner Credentials</h3>
        {!creating && !fresh && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            Generate Credential
          </button>
        )}
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        API credentials partners use to upload embossing batches via HTTP
        (HMAC-SHA256).  Secrets are shown ONCE at creation — store them
        securely.
      </p>

      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}

      {fresh && <FreshCredentialPanel result={fresh} onClose={() => setFresh(null)} />}

      {creating && (
        <div className="panel panel-2" style={{ marginTop: 12 }}>
          <label>Description (optional)</label>
          <input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="InComm production upload pipeline"
            disabled={busy}
          />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={submitCreate} disabled={busy}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
            <button
              className="btn ghost"
              onClick={() => { setCreating(false); setNewDescription(''); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="small" style={{ marginTop: 12 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>
          No credentials yet.  Generate one to let a partner upload batches.
        </p>
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Description</th>
              <th>Status</th>
              <th>Last Used</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.keyId}</td>
                <td className="small">{r.description ?? <span className="small">—</span>}</td>
                <td>
                  <StatusChip label={r.status} tone={statusToneFor(r.status)} />
                  {r.status === 'REVOKED' && r.revokedReason && (
                    <div className="small" style={{ marginTop: 2 }}>{r.revokedReason}</div>
                  )}
                </td>
                <td className="small">
                  {r.lastUsedAt ? (
                    <>
                      {formatDate(r.lastUsedAt)}
                      {r.lastUsedIp && <div className="small mono">{r.lastUsedIp}</div>}
                    </>
                  ) : (
                    <span className="small">never</span>
                  )}
                </td>
                <td className="small">{formatDate(r.createdAt)}</td>
                <td>
                  {r.status === 'ACTIVE' && (
                    <button className="btn ghost" onClick={() => revoke(r)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * "Shown once" panel displayed after a new credential is minted.  Bright
 * warning treatment (amber) because this is the only time the partner (and
 * the admin relaying it) will ever see the plaintext secret.  Includes
 * copy-buttons for every sensitive field plus a collapsible helper that
 * documents the HMAC signing scheme for partners.
 */
function FreshCredentialPanel({
  result,
  onClose,
}: {
  result: NewCredentialResult;
  onClose: () => void;
}) {
  const style = {
    marginTop: 12,
    padding: 16,
    background: 'rgba(255, 191, 107, 0.08)',
    border: '1px solid var(--warn)',
    borderRadius: 'var(--radius)',
  } as const;
  return (
    <div style={style}>
      <h4 style={{ margin: 0, color: 'var(--warn)' }}>
        Credential created — store these values now
      </h4>
      <p className="small" style={{ marginTop: 6 }}>
        The secret below will NEVER be shown again.  Copy every field into your
        partner's secret manager before closing this panel.
      </p>

      <CopyableField label="Key ID" value={result.keyId} />
      <CopyableField label="Secret (plaintext — shown once)" value={result.secret} sensitive />
      <CopyableField label="Secret Hash (HMAC key — hex)" value={result.secretHash} sensitive />
      <CopyableField label="Salt (hex)" value={result.salt} />

      <details style={{ marginTop: 14 }}>
        <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>
          How to sign a partner request (HMAC-SHA256)
        </summary>
        <div style={{ marginTop: 10 }}>
          <p className="small" style={{ marginTop: 0 }}>
            Canonical string to sign (exact newline separators, no trailing
            newline):
          </p>
          <pre className="mono" style={preStyle}>
{`METHOD\\nPATH\\nTIMESTAMP\\nSHA256(body)`}
          </pre>
          <p className="small">
            The HMAC key is the hex-decoded <strong>Secret Hash</strong> above
            (not the plaintext secret).  Replay window: ±60 seconds.
          </p>
          <p className="small">Required headers:</p>
          <ul className="small" style={{ marginTop: 4 }}>
            <li><span className="mono">X-Partner-KeyId</span></li>
            <li><span className="mono">X-Partner-Signature</span> (hex)</li>
            <li><span className="mono">X-Partner-Timestamp</span> (unix seconds)</li>
            <li><span className="mono">X-Partner-TemplateId</span></li>
            <li><span className="mono">X-Partner-ProgramId</span></li>
            <li><span className="mono">X-Partner-FileName</span> (optional)</li>
          </ul>
          <p className="small">Sample curl (bash):</p>
          <pre className="mono" style={preStyle}>
{`BODY_HASH=$(sha256sum batch.csv | awk '{print $1}')
TS=$(date +%s)
CANONICAL="POST\\n/api/partners/embossing-batches\\n\${TS}\\n\${BODY_HASH}"
SIG=$(echo -en "$CANONICAL" | openssl dgst -sha256 -mac HMAC \\
  -macopt "hexkey:\${SECRET_HASH}" | awk '{print $2}')

curl -X POST https://manage.karta.cards/api/partners/embossing-batches \\
  -H "X-Partner-KeyId: \${KEY_ID}" \\
  -H "X-Partner-Signature: \${SIG}" \\
  -H "X-Partner-Timestamp: \${TS}" \\
  -H "X-Partner-TemplateId: \${TEMPLATE_ID}" \\
  -H "X-Partner-ProgramId: \${PROGRAM_ID}" \\
  --data-binary @batch.csv`}
          </pre>
        </div>
      </details>

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={onClose}>
          I've stored these securely, close
        </button>
      </div>
    </div>
  );
}

const preStyle = {
  background: 'var(--panel-2)',
  border: '1px solid var(--edge)',
  borderRadius: 'var(--radius)',
  padding: 10,
  fontSize: 12,
  overflowX: 'auto' as const,
  whiteSpace: 'pre' as const,
  margin: '6px 0',
};
