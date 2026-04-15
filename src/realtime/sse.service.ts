import type { Response } from 'express';

// -----------------------------------------------------------------------------
// Server-Sent Events pub/sub, keyed by RLID.
//
// Both the merchant desktop page and the customer phone page subscribe to the
// same RLID.  The phone subscribes late (after QR scan), so we keep the last
// event emitted on each RLID and replay it on connect — otherwise a phone
// that lands on /pay/{rlid} after "auth_started" has fired would never see it.
//
// Heartbeat every 15s to keep Cloudflare Tunnel's ~100s idle cutoff from
// dropping long-lived streams.
// -----------------------------------------------------------------------------

export type SseEventType =
  | 'transaction_created'
  | 'authn_started'
  | 'authn_complete'
  | 'arqc_valid'
  | 'vault_retrieved'
  | 'provider_tokenised'
  | 'charged'
  | 'completed'
  | 'failed'
  | 'expired';

export interface SseEvent {
  type: SseEventType;
  rlid: string;
  at: string; // ISO timestamp
  data?: Record<string, unknown>;
}

const HEARTBEAT_MS = 15_000;

class SseBus {
  private subscribers = new Map<string, Set<Response>>();
  private lastByRlid = new Map<string, SseEvent[]>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor() {
    this.heartbeat = setInterval(() => {
      if (this.subscribers.size === 0) return;
      for (const subs of this.subscribers.values()) {
        for (const res of subs) {
          try {
            res.write(`:heartbeat\n\n`);
          } catch {
            // Ignore — dead connection will be removed on next attempt.
          }
        }
      }
    }, HEARTBEAT_MS);
    // Unref so Node doesn't wait on the interval at shutdown.
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  publish(event: SseEvent): void {
    const history = this.lastByRlid.get(event.rlid) ?? [];
    history.push(event);
    // Keep the last ~20 events for late subscribers — bounded so we don't
    // leak memory on runaway RLIDs.
    while (history.length > 20) history.shift();
    this.lastByRlid.set(event.rlid, history);

    const subs = this.subscribers.get(event.rlid);
    if (!subs) return;
    const payload = formatSse(event);
    for (const res of subs) {
      try {
        res.write(payload);
      } catch {
        // connection probably closed; cleanup on next tick via req.on('close')
      }
    }
  }

  subscribe(rlid: string, res: Response): () => void {
    // SSE headers.  X-Accel-Buffering: no is crucial through proxies like
    // Cloudflare Tunnel that otherwise buffer the response.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    // Replay history so late subscribers get the current state.
    const history = this.lastByRlid.get(rlid) ?? [];
    for (const ev of history) res.write(formatSse(ev));

    let subs = this.subscribers.get(rlid);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(rlid, subs);
    }
    subs.add(res);

    const unsub = () => {
      subs?.delete(res);
      if (subs && subs.size === 0) this.subscribers.delete(rlid);
    };
    return unsub;
  }

  /** Drop history for a terminal RLID — called when a txn is definitively done. */
  forget(rlid: string): void {
    this.lastByRlid.delete(rlid);
  }
}

function formatSse(event: SseEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

export const sseBus = new SseBus();

/** Convenience helper to publish a structured event with a timestamp. */
export function publish(rlid: string, type: SseEventType, data?: Record<string, unknown>) {
  sseBus.publish({ type, rlid, at: new Date().toISOString(), data });
}
