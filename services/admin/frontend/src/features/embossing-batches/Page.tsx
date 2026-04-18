import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg, getAuthToken } from '../../utils/api';
import { formatBytes, formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { BatchStatusCell, BatchRecordsCell } from './StatusCells';
import type { Program } from '../programs/types';
import type { EmbossingTemplateRow } from '../embossing-templates/types';

export interface EmbossingBatchRow {
  id: string;
  templateId: string;
  programId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  s3Bucket: string;
  s3Key: string;
  status: string;
  recordCount: number | null;
  recordsSuccess: number;
  recordsFailed: number;
  processingError: string | null;
  uploadedVia: string;
  uploadedBy: string | null;
  uploadedAt: string;
  processedAt: string | null;
  template: { id: string; name: string } | null;
}

export function EmbossingBatchesPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [batches, setBatches] = useState<EmbossingBatchRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const selectedProgram = programs.find((p) => p.id === selectedProgramId) ?? null;

  useEffect(() => {
    api.get<Program[]>('/programs')
      .then((p) => {
        setPrograms(p);
        if (p.length > 0) setSelectedProgramId((prev) => prev || p[0].id);
      })
      .catch((e) => setErr(errorMsg(e)));
  }, []);

  // When program changes, refresh the template list (scoped to the program's FI)
  // and default the template selection to the program's configured template.
  useEffect(() => {
    if (!selectedProgram?.financialInstitutionId) {
      setTemplates([]);
      setSelectedTemplateId('');
      return;
    }
    api.get<EmbossingTemplateRow[]>(
      `/admin/financial-institutions/${selectedProgram.financialInstitutionId}/embossing-templates`,
    )
      .then((list) => {
        setTemplates(list);
        setSelectedTemplateId(
          selectedProgram.embossingTemplateId && list.some((t) => t.id === selectedProgram.embossingTemplateId)
            ? selectedProgram.embossingTemplateId
            : list[0]?.id ?? '',
        );
      })
      .catch(() => {
        setTemplates([]);
        setSelectedTemplateId('');
      });
  }, [selectedProgram]);

  const load = useCallback(async () => {
    if (!selectedProgramId) {
      setBatches([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.get<EmbossingBatchRow[]>(
        `/admin/programs/${selectedProgramId}/embossing-batches`,
      );
      setBatches(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProgramId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 10 s so status transitions driven by the batch-processor
  // worker (RECEIVED → PROCESSING → PROCESSED/FAILED) surface without a
  // manual refresh.
  useEffect(() => {
    if (!selectedProgramId) return;
    const id = window.setInterval(() => {
      api.get<EmbossingBatchRow[]>(`/admin/programs/${selectedProgramId}/embossing-batches`)
        .then(setBatches)
        .catch(() => {});
    }, 10_000);
    return () => window.clearInterval(id);
  }, [selectedProgramId]);

  const handleUpload = async () => {
    if (!selectedProgramId || !file || !selectedTemplateId) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('templateId', selectedTemplateId);
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(
        `/api/admin/programs/${selectedProgramId}/embossing-batches`,
        { method: 'POST', headers, body: formData },
      );
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      setOk(`Uploaded batch ${respData.fileName} (${respData.id})`);
      setFile(null);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const columns: Column<EmbossingBatchRow>[] = [
    {
      key: 'file',
      header: 'File',
      width: '22%',
      render: (b) => (
        <>
          <div title={b.fileName}>{b.fileName}</div>
          <div className="small mono" title={b.sha256}>{b.sha256.slice(0, 16)}…</div>
        </>
      ),
      sort: (b) => b.fileName,
    },
    { key: 'size', header: 'Size', width: '8%', mono: true, align: 'right', render: (b) => formatBytes(b.fileSize) },
    { key: 'template', header: 'Template', width: '16%', render: (b) => <span className="small">{b.template?.name ?? '—'}</span> },
    { key: 'status', header: 'Status', width: '18%', render: (b) => <BatchStatusCell batch={b} /> },
    { key: 'records', header: 'Records', width: '14%', mono: true, render: (b) => <BatchRecordsCell batch={b} /> },
    { key: 'via', header: 'Via', width: '8%', render: (b) => <span className="small">{b.uploadedVia}</span> },
    { key: 'uploaded', header: 'Uploaded', width: '14%', render: (b) => <span className="small">{formatDate(b.uploadedAt)}</span>, sort: (b) => b.uploadedAt },
  ];

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Embossing Batches</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Upload a card-data file for a program.  The raw file is encrypted
        at rest (SSE-KMS in S3); a background worker parses records and
        routes each through the vault's registerCard flow — PANs never land
        in plaintext on this path.
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

      {selectedProgram && (
        <p className="small" style={{ marginTop: 8 }}>
          Configured template for this program:{' '}
          {selectedProgram.embossingTemplate ? (
            <span className="mono">{selectedProgram.embossingTemplate.name}</span>
          ) : (
            <span>none — set one on the program to default it here.</span>
          )}
        </p>
      )}

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <h3 style={{ marginTop: 20 }}>Upload new batch</h3>

      <label>Template</label>
      <select
        value={selectedTemplateId}
        onChange={(e) => setSelectedTemplateId(e.target.value)}
        disabled={uploading}
      >
        {templates.length === 0 && <option value="">No templates for this FI</option>}
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name} ({t.formatType})</option>
        ))}
      </select>

      <label>Batch file (max 500 MB)</label>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedProgramId || !selectedTemplateId}
        >
          {uploading ? 'Uploading…' : 'Upload batch'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Batches</h3>
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={batches}
          rowKey={(b) => b.id}
          searchPlaceholder="Search by file name or sha256…"
          searchMatch={(b, q) =>
            b.fileName.toLowerCase().includes(q) ||
            b.sha256.toLowerCase().includes(q) ||
            (b.template?.name.toLowerCase().includes(q) ?? false)
          }
          empty={<p className="small">No batches yet for this program.</p>}
        />
      )}
    </div>
  );
}
