import { useEffect, useState } from 'react';
import { api, getAuthToken } from '../../utils/api';
import type { Program } from '../programs/types';

interface BatchResult {
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
  errors: { row: number; cardRef: string; error: string }[];
}

export function BatchesPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programId, setProgramId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Program[]>('/programs').then((p) => {
      setPrograms(p);
      if (p.length > 0 && !programId) setProgramId(p[0].id);
    }).catch(() => setPrograms([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!file || !programId) return;
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('programId', programId);

      const adminKey = sessionStorage.getItem('vera.adminKey');
      const headers: Record<string, string> = {};
      if (adminKey) headers['x-admin-key'] = adminKey;
      const token = getAuthToken();
      if (token) headers['authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/admin/batches/ingest', {
        method: 'POST',
        headers,
        body: form,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
      setResult(data as BatchResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Batch CSV Ingestion</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Upload a manufacturing CSV to register cards in bulk. Each row calls
        activation's card register endpoint with HMAC-signed auth.
      </p>
      <p className="small" style={{ marginTop: 4 }}>
        Required columns: card_ref, ntag_uid, chip_serial, pan, expiry_month,
        expiry_year, cardholder_name
      </p>

      <label>Program</label>
      <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      <label>Batch CSV</label>
      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || !file || !programId}
        >
          {busy ? 'Processing...' : 'Upload & Process'}
        </button>
      </div>

      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Total rows" value={result.total} />
            <Stat label="Succeeded" value={result.succeeded} />
            <Stat label="Failed" value={result.failed} danger={result.failed > 0} />
            <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
              <div className="mono small" style={{ wordBreak: 'break-all' }}>{result.batchId}</div>
              <div className="small">Batch ID</div>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3>Errors</h3>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Card ref</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.row}</td>
                      <td className="mono">{e.cardRef}</td>
                      <td><span className="tag err">{e.error}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
      <div className="mono" style={{ fontSize: 28, fontWeight: 700, color: danger ? 'var(--tone-danger-fg)' : undefined }}>
        {value}
      </div>
      <div className="small">{label}</div>
    </div>
  );
}
