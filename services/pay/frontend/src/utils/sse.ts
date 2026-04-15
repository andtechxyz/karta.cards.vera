import { useEffect, useState } from 'react';

// -----------------------------------------------------------------------------
// Thin React hook for subscribing to /api/payment/status/:rlid over SSE.
//
// Returns a rolling list of events received plus the last one and a `terminal`
// boolean for convenience.  The server-side bus replays the last ~20 events on
// connect, so subscribing late still catches intermediate progress.
// -----------------------------------------------------------------------------

// Must match SseEventType in src/realtime/sse.service.ts.  Frontend and
// backend are separate compilation units; sharing types would need a third
// package, so this list is duplicated by design with a pointer comment.
export const SSE_EVENT_TYPES = [
  'transaction_created',
  'authn_started',
  'authn_complete',
  'arqc_valid',
  'vault_retrieved',
  'provider_tokenised',
  'charged',
  'completed',
  'failed',
  'expired',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export const TERMINAL_EVENT_TYPES: ReadonlySet<SseEventType> = new Set([
  'completed',
  'failed',
  'expired',
]);

export function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type as SseEventType);
}

export interface SseEvent {
  type: SseEventType;
  rlid: string;
  at: string;
  data?: Record<string, unknown>;
}

export function usePaymentSse(rlid: string | undefined): {
  events: SseEvent[];
  last?: SseEvent;
  terminal: boolean;
  error: string | null;
} {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rlid) return;
    const es = new EventSource(`/api/payment/status/${rlid}`);

    // Named-event listeners for each type we emit server-side.  Using
    // `es.onmessage` alone would miss them (EventSource dispatches named
    // events only via addEventListener).
    const handle = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as SseEvent;
        setEvents((prev) => [...prev, parsed]);
      } catch {
        // ignore malformed
      }
    };
    for (const type of SSE_EVENT_TYPES) {
      es.addEventListener(type, handle as EventListener);
    }

    es.onerror = () => setError('SSE connection error');

    return () => {
      es.close();
    };
  }, [rlid]);

  const last = events[events.length - 1];
  return {
    events,
    last,
    terminal: last ? isTerminalEvent(last.type) : false,
    error,
  };
}
