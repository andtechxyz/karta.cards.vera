import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { sseBus, publish } from './sse.service.js';

// Minimal Response stub — captures everything the SseBus writes so we can
// inspect headers + frames without spinning up a real Express server.  The
// `as unknown as Response` cast sidesteps Express's heavily-overloaded
// writeHead signature; the SseBus only invokes the 2-arg shape we model.
function makeStubResponse() {
  const writes: string[] = [];
  let head: { status?: number; headers?: Record<string, string> } = {};
  const stub = {
    writeHead(status: number, headers?: Record<string, string>) {
      head = { status, headers };
      return stub;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
  return { res: stub as unknown as Response, writes, head: () => head };
}

describe('SSE bus — late-subscriber replay', () => {
  it('replays the last events to a subscriber that joins after publish', () => {
    const rlid = 'rl_late_1';
    publish(rlid, 'transaction_created');
    publish(rlid, 'authn_started');

    const { res, writes } = makeStubResponse();
    const unsub = sseBus.subscribe(rlid, res);

    // First write is the :connected probe; then 2 replayed events.
    expect(writes[0]).toBe(':connected\n\n');
    const eventFrames = writes.slice(1);
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);
    expect(eventFrames[0]).toMatch(/event: transaction_created/);
    expect(eventFrames[1]).toMatch(/event: authn_started/);

    unsub();
    sseBus.forget(rlid);
  });

  it('streams new events to live subscribers', () => {
    const rlid = 'rl_live_1';
    const { res, writes } = makeStubResponse();
    const unsub = sseBus.subscribe(rlid, res);
    const before = writes.length;

    publish(rlid, 'arqc_valid', { atc: 7 });

    expect(writes.length).toBe(before + 1);
    expect(writes[before]).toMatch(/event: arqc_valid/);
    expect(writes[before]).toMatch(/"atc":7/);

    unsub();
    sseBus.forget(rlid);
  });

  it('writes the SSE-required headers on subscribe', () => {
    const rlid = 'rl_headers';
    const { res, head } = makeStubResponse();
    const unsub = sseBus.subscribe(rlid, res);

    const h = head().headers ?? {};
    expect(h['Content-Type']).toBe('text/event-stream');
    expect(h['Cache-Control']).toMatch(/no-cache/);
    expect(h['X-Accel-Buffering']).toBe('no'); // Cloudflare Tunnel buffer-defeat
    expect(h.Connection).toBe('keep-alive');

    unsub();
    sseBus.forget(rlid);
  });

  it('isolates events between RLIDs', () => {
    const a = 'rl_iso_a';
    const b = 'rl_iso_b';
    const subA = makeStubResponse();
    const subB = makeStubResponse();
    const ua = sseBus.subscribe(a, subA.res);
    const ub = sseBus.subscribe(b, subB.res);

    publish(a, 'completed');

    const aGotIt = subA.writes.some((w) => /event: completed/.test(w));
    const bGotIt = subB.writes.some((w) => /event: completed/.test(w));
    expect(aGotIt).toBe(true);
    expect(bGotIt).toBe(false);

    ua();
    ub();
    sseBus.forget(a);
    sseBus.forget(b);
  });

  it('forget(rlid) drops history so a fresh subscriber receives no replay', () => {
    const rlid = 'rl_forget';
    publish(rlid, 'failed');
    sseBus.forget(rlid);

    const { res, writes } = makeStubResponse();
    const unsub = sseBus.subscribe(rlid, res);

    // Only the :connected probe — no replayed event.
    expect(writes).toEqual([':connected\n\n']);
    unsub();
  });
});
