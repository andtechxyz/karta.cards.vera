import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg, getAuthToken } from '../../utils/api';
import { formatBytes, formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip } from '../../components/StatusChip';

// Program-scoped static site hosting.  Each upload is a zip of the built
// microsite; activating a version copies its files under the `current/`
// prefix so the CDN (microsite.karta.cards) serves them. Disable clears the
// enabled flag without deleting any versions.

interface MicrositeVersion {
  id: string;
  version: string;
  s3Prefix: string;
  uploadedBy: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

interface MicrositeData {
  programId: string;
  enabled: boolean;
  activeVersion: string | null;
  versions: MicrositeVersion[];
}

interface ProgramRow {
  id: string;
  name: string;
  currency: string;
}

export function MicrositesPage() {
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [data, setData] = useState<MicrositeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [versionLabel, setVersionLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    api.get<ProgramRow[]>('/programs').then((p) => {
      setPrograms(p);
      if (p.length > 0) setSelectedProgramId((prev) => prev || p[0].id);
    }).catch((e) => setErr(errorMsg(e)));
  }, []);

  const load = useCallback(async () => {
    if (!selectedProgramId) { setData(null); return; }
    try {
      const r = await api.get<MicrositeData>(`/admin/programs/${selectedProgramId}/microsites`);
      setData(r);
    } catch (e) {
      setErr(errorMsg(e));
    }
  }, [selectedProgramId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async () => {
    if (!file || !selectedProgramId) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      if (versionLabel.trim()) formData.append('version', versionLabel.trim());
      formData.append('file', file);
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/admin/programs/${selectedProgramId}/microsites`, {
        method: 'POST',
        headers,
        body: formData,
      });
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      const newVer = respData as MicrositeVersion;
      setOk(`Uploaded version ${newVer.version} (${newVer.id})`);
      setVersionLabel('');
      setFile(null);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (versionId: string) => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setActivatingId(versionId);
    try {
      await api.post(`/admin/programs/${selectedProgramId}/microsites/${versionId}/activate`);
      setOk(`Activated version ${versionId}`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setActivatingId(null);
    }
  };

  const handleDelete = async (versionId: string) => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setDeletingId(versionId);
    try {
      await api.delete(`/admin/programs/${selectedProgramId}/microsites/${versionId}`);
      setOk(`Deleted version ${versionId}`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleDisable = async () => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setDisabling(true);
    try {
      await api.post(`/admin/programs/${selectedProgramId}/microsites/disable`);
      setOk('Microsite disabled');
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setDisabling(false);
    }
  };

  const liveUrl = selectedProgramId
    ? `https://microsite.karta.cards/programs/${selectedProgramId}/`
    : null;

  const versionColumns: Column<MicrositeVersion>[] = [
    { key: 'version', header: 'Version', width: '18%', mono: true, copyable: (v) => v.version, render: (v) => v.version },
    { key: 'files', header: 'Files', width: '10%', mono: true, align: 'right', render: (v) => v.fileCount },
    { key: 'size', header: 'Size', width: '12%', mono: true, align: 'right', render: (v) => formatBytes(v.totalBytes) },
    { key: 'uploadedBy', header: 'Uploaded By', width: '18%', render: (v) => <span className="small">{v.uploadedBy}</span> },
    { key: 'uploadedAt', header: 'Uploaded At', width: '18%', render: (v) => <span className="small">{formatDate(v.createdAt)}</span>, sort: (v) => v.createdAt },
    {
      key: 'actions',
      header: 'Actions',
      width: '24%',
      render: (v) => {
        const isActive = data?.activeVersion === v.id;
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            {isActive ? (
              <StatusChip label="Active" tone="success" />
            ) : (
              <button
                className="btn primary"
                style={{ minHeight: 0, padding: '4px 10px', fontSize: 12 }}
                onClick={(e) => { e.stopPropagation(); handleActivate(v.id); }}
                disabled={activatingId === v.id}
              >
                {activatingId === v.id ? 'Activating…' : 'Activate'}
              </button>
            )}
            <button
              className="btn ghost"
              style={{ minHeight: 0, padding: '4px 10px', fontSize: 12 }}
              onClick={(e) => { e.stopPropagation(); handleDelete(v.id); }}
              disabled={isActive || deletingId === v.id}
              title={isActive ? 'Cannot delete the active version — disable or activate another first' : 'Delete this version'}
            >
              {deletingId === v.id ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Microsites</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Per-program static sites served from <span className="mono">microsite.karta.cards</span>.
        Upload a zipped build, then activate a version to publish it. Requires
        a DNS CNAME to the microsite CDN.
      </p>

      <label>Program</label>
      <select
        value={selectedProgramId}
        onChange={(e) => { setSelectedProgramId(e.target.value); setOk(null); setErr(null); }}
      >
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {data && (
        <div className="panel panel-2" style={{ marginTop: 16 }}>
          <h3 style={{ margin: 0 }}>Current state</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <div className="small">Status</div>
              <StatusChip label={data.enabled ? 'Enabled' : 'Disabled'} tone={data.enabled ? 'success' : 'neutral'} />
            </div>
            <div>
              <div className="small">Active version</div>
              <div className="mono">{data.activeVersion ?? 'None'}</div>
            </div>
            <div>
              <div className="small">Live URL</div>
              {data.enabled && liveUrl ? (
                <a href={liveUrl} target="_blank" rel="noreferrer" className="mono small">
                  {liveUrl}
                </a>
              ) : (
                <span className="small">—</span>
              )}
            </div>
          </div>
          {data.enabled && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={handleDisable} disabled={disabling}>
                {disabling ? 'Disabling…' : 'Disable microsite'}
              </button>
            </div>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Upload new version</h3>
      <p className="small">
        Upload a <span className="mono">.zip</span> of the built microsite.
        The version label is optional — if omitted the server assigns one.
      </p>

      <label>Version label (optional)</label>
      <input
        value={versionLabel}
        onChange={(e) => setVersionLabel(e.target.value)}
        className="mono"
        placeholder="v1"
        disabled={uploading}
      />

      <label>Zip file</label>
      <input
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedProgramId}
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Versions</h3>
      {!data || data.versions.length === 0 ? (
        <p className="small">No versions uploaded for this program yet.</p>
      ) : (
        <Table
          columns={versionColumns}
          rows={data.versions}
          rowKey={(v) => v.id}
          searchPlaceholder="Search by version label…"
          searchMatch={(v, q) =>
            v.version.toLowerCase().includes(q) ||
            v.uploadedBy.toLowerCase().includes(q)
          }
        />
      )}
    </div>
  );
}
