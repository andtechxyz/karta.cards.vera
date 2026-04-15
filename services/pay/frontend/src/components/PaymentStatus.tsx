import { isTerminalEvent, type SseEvent, type SseEventType } from '../utils/sse';

// -----------------------------------------------------------------------------
// Progress list used by both the merchant desktop page and the customer phone
// page.  Rendered as a vertical timeline of the SSE events received so far,
// with terminal states highlighted.
// -----------------------------------------------------------------------------

const STEPS: { type: SseEventType; label: string }[] = [
  { type: 'transaction_created', label: 'Transaction created' },
  { type: 'authn_started', label: 'Authentication started' },
  { type: 'authn_complete', label: 'Authentication verified' },
  { type: 'arqc_valid', label: 'OBO ARQC generated' },
  { type: 'vault_retrieved', label: 'Vault token consumed' },
  { type: 'provider_tokenised', label: 'Provider tokenised' },
  { type: 'charged', label: 'Charge succeeded' },
  { type: 'completed', label: 'Complete' },
];

export default function PaymentStatus({ events }: { events: SseEvent[] }) {
  const reached = new Set(events.map((e) => e.type));
  const terminal = events.find((e) => isTerminalEvent(e.type));

  return (
    <div className="panel panel-2">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {STEPS.map((s) => {
          const ev = events.find((e) => e.type === s.type);
          const done = reached.has(s.type);
          return (
            <div
              key={s.type}
              style={{ display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <span
                className={`tag ${done ? 'ok' : ''}`}
                style={{ minWidth: 22, textAlign: 'center' }}
              >
                {done ? '✓' : '·'}
              </span>
              <span style={{ flex: 1, opacity: done ? 1 : 0.5 }}>{s.label}</span>
              {ev?.data?.atc !== undefined && (
                <span className="small mono">ATC {String(ev.data.atc)}</span>
              )}
              {ev?.data?.last4 !== undefined && (
                <span className="small mono">•••• {String(ev.data.last4)}</span>
              )}
            </div>
          );
        })}
      </div>
      {terminal && terminal.type !== 'completed' && (
        <p className="tag err" style={{ marginTop: 12 }}>
          {terminal.type.toUpperCase()}
          {terminal.data?.reason ? ` — ${String(terminal.data.reason)}` : ''}
        </p>
      )}
      {terminal?.type === 'completed' && (
        <p className="tag ok" style={{ marginTop: 12 }}>
          Payment complete
          {terminal.data?.providerTxnId
            ? ` — ${String(terminal.data.providerTxnId).slice(0, 24)}…`
            : ''}
        </p>
      )}
    </div>
  );
}
