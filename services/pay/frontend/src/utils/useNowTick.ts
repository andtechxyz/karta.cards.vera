import { useEffect, useState } from 'react';

/**
 * 1Hz (or custom) wall-clock tick for countdown UIs.
 *
 * Returns a millisecond epoch quantised to whole seconds — so consumers that
 * only care about `secondsUntil(iso, now)` get bailed-out renders by React's
 * `Object.is` setState guard when the visible second hasn't actually changed.
 * (Prevents a 1Hz re-render of every consumer table when only one row's
 * countdown advances.)
 *
 * Pass `enabled: false` to suspend ticking on terminal states.
 */
export function useNowTick(enabled: boolean = true, intervalMs: number = 1000): number {
  const [seconds, setSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setSeconds(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return seconds * 1000;
}
