import { StatusChip } from '../../components/StatusChip';
import type { EmbossingBatchRow } from './Page';

/**
 * Colour-coded batch status badge.
 *
 *   RECEIVED   → neutral — uploaded but not picked up yet
 *   PROCESSING → warn with a spinner — worker is parsing
 *   PROCESSED  → success with "N/M records" subline
 *   FAILED     → danger with truncated error + full error in title tooltip
 *
 * Keeps visual weight in the status column; the Records column stays a
 * compact "successes / total · failed" tally for PROCESSED rows so admins
 * can spot partial failures at a glance.
 */
export function BatchStatusCell({ batch }: { batch: EmbossingBatchRow }) {
  const s = batch.status;
  if (s === 'PROCESSED') {
    return (
      <div>
        <StatusChip label="PROCESSED" tone="success" />
        {batch.recordCount !== null && (
          <div className="small" style={{ marginTop: 2 }}>
            {batch.recordsSuccess}/{batch.recordCount} records
          </div>
        )}
      </div>
    );
  }
  if (s === 'FAILED') {
    const full = batch.processingError ?? 'Processing failed';
    const truncated = full.length > 80 ? `${full.slice(0, 77)}…` : full;
    return (
      <div>
        <StatusChip label="FAILED" tone="danger" />
        <div className="tag err" style={{ marginTop: 4 }} title={full}>
          {truncated}
        </div>
      </div>
    );
  }
  if (s === 'PROCESSING') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusChip label="PROCESSING" tone="info" />
        <BatchSpinner />
      </div>
    );
  }
  if (s === 'RECEIVED') {
    return <StatusChip label="RECEIVED" tone="neutral" />;
  }
  return <StatusChip label={s} tone="neutral" />;
}

export function BatchRecordsCell({ batch }: { batch: EmbossingBatchRow }) {
  if (batch.recordCount === null) return <>—</>;
  if (batch.status === 'PROCESSED') {
    return (
      <>
        {batch.recordsSuccess} / {batch.recordCount}
        {batch.recordsFailed > 0 && ` · ${batch.recordsFailed} failed`}
      </>
    );
  }
  return (
    <>
      {batch.recordsSuccess}/{batch.recordCount}
      {batch.recordsFailed > 0 && ` (${batch.recordsFailed} failed)`}
    </>
  );
}

function BatchSpinner() {
  return (
    <span
      aria-label="processing"
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '2px solid var(--edge)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'vera-spin 0.9s linear infinite',
      }}
    />
  );
}
