import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg, getAuthToken } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import type { FinancialInstitution } from '../financial-institutions/types';
import type { EmbossingTemplateRow } from './types';

export function EmbossingTemplatesPage() {
  const [fis, setFis] = useState<FinancialInstitution[]>([]);
  const [selectedFiId, setSelectedFiId] = useState<string>('');
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formatType, setFormatType] = useState('episode_six');
  const [supportsVisa, setSupportsVisa] = useState(false);
  const [supportsMastercard, setSupportsMastercard] = useState(false);
  const [supportsAmex, setSupportsAmex] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.get<FinancialInstitution[]>('/admin/financial-institutions')
      .then((list) => {
        setFis(list);
        if (list.length > 0) setSelectedFiId((prev) => prev || list[0].id);
      })
      .catch((e) => setErr(errorMsg(e)));
  }, []);

  const load = useCallback(async () => {
    if (!selectedFiId) {
      setTemplates([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.get<EmbossingTemplateRow[]>(
        `/admin/financial-institutions/${selectedFiId}/embossing-templates`,
      );
      setTemplates(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [selectedFiId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async () => {
    if (!selectedFiId || !file) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (name.trim()) formData.append('name', name.trim());
      if (description.trim()) formData.append('description', description.trim());
      formData.append('formatType', formatType);
      formData.append('supportsVisa', String(supportsVisa));
      formData.append('supportsMastercard', String(supportsMastercard));
      formData.append('supportsAmex', String(supportsAmex));
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(
        `/api/admin/financial-institutions/${selectedFiId}/embossing-templates`,
        { method: 'POST', headers, body: formData },
      );
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      const newTpl = respData as EmbossingTemplateRow;
      setOk(`Uploaded template "${newTpl.name}"`);
      setName('');
      setDescription('');
      setFile(null);
      setSupportsVisa(false);
      setSupportsMastercard(false);
      setSupportsAmex(false);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!selectedFiId) return;
    setErr(null);
    setOk(null);
    try {
      await api.delete(
        `/admin/financial-institutions/${selectedFiId}/embossing-templates/${templateId}`,
      );
      setOk(`Deleted template`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  const columns: Column<EmbossingTemplateRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: '22%',
      render: (t) => (
        <>
          {t.name}
          {t.description && <div className="small">{t.description}</div>}
        </>
      ),
      sort: (t) => t.name,
    },
    { key: 'format', header: 'Format', width: '10%', mono: true, render: (t) => t.formatType },
    {
      key: 'schemes',
      header: 'Schemes',
      width: '14%',
      render: (t) => (
        <>
          {t.supportsVisa && <span className="tag" style={{ marginRight: 4 }}>Visa</span>}
          {t.supportsMastercard && <span className="tag" style={{ marginRight: 4 }}>MC</span>}
          {t.supportsAmex && <span className="tag" style={{ marginRight: 4 }}>Amex</span>}
          {!t.supportsVisa && !t.supportsMastercard && !t.supportsAmex && (
            <span className="small">—</span>
          )}
        </>
      ),
    },
    { key: 'fields', header: 'Fields', width: '8%', mono: true, align: 'right', render: (t) => t.fieldCount ?? '—' },
    { key: 'record', header: 'Record len', width: '10%', mono: true, align: 'right', render: (t) => t.recordLength ?? '—' },
    { key: 'file', header: 'File', width: '16%', render: (t) => <span className="small" title={t.templateFileName}>{t.templateFileName}</span> },
    { key: 'uploaded', header: 'Uploaded', width: '12%', render: (t) => <span className="small">{formatDate(t.createdAt)}</span>, sort: (t) => t.createdAt },
    {
      key: 'actions',
      header: '',
      width: '8%',
      render: (t) => (
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}>
          Delete
        </button>
      ),
    },
  ];

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Embossing Templates</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Per-FI schema definitions describing how batch card-data files are
        parsed.  Templates are encrypted at rest; batch uploads reference
        a template so the parser knows the record layout.  Visa + Mastercard
        can share a template when the underlying format is identical.
      </p>

      <label>Financial Institution</label>
      <select
        value={selectedFiId}
        onChange={(e) => { setSelectedFiId(e.target.value); setOk(null); setErr(null); }}
      >
        {fis.length === 0 && <option value="">No FIs available — create one first</option>}
        {fis.map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
        ))}
      </select>

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <h3 style={{ marginTop: 20 }}>Upload new template</h3>

      <label>Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="InComm Standard v2"
        disabled={uploading}
      />

      <label>Description (optional)</label>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Record layout for InComm's Q2 2026 cards"
        disabled={uploading}
      />

      <label>Format type</label>
      <select
        value={formatType}
        onChange={(e) => setFormatType(e.target.value)}
        disabled={uploading}
      >
        <option value="episode_six">Episode Six</option>
        <option value="fixed_width">Fixed-width</option>
        <option value="csv">CSV</option>
        <option value="xml">XML</option>
      </select>

      <label>Supported schemes</label>
      <div style={{ display: 'flex', gap: 16, paddingTop: 4 }}>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsVisa}
            onChange={(e) => setSupportsVisa(e.target.checked)}
            disabled={uploading}
          />
          Visa
        </label>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsMastercard}
            onChange={(e) => setSupportsMastercard(e.target.checked)}
            disabled={uploading}
          />
          Mastercard
        </label>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsAmex}
            onChange={(e) => setSupportsAmex(e.target.checked)}
            disabled={uploading}
          />
          Amex
        </label>
      </div>

      <label style={{ marginTop: 12 }}>Template file (max 10 MB)</label>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedFiId || !name.trim()}
        >
          {uploading ? 'Uploading…' : 'Upload template'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Templates</h3>
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={templates}
          rowKey={(t) => t.id}
          searchPlaceholder="Search template name or file…"
          searchMatch={(t, q) =>
            t.name.toLowerCase().includes(q) ||
            (t.description?.toLowerCase().includes(q) ?? false) ||
            t.templateFileName.toLowerCase().includes(q) ||
            t.formatType.toLowerCase().includes(q)
          }
          empty={<p className="small">No templates yet for this FI.</p>}
        />
      )}
    </div>
  );
}
