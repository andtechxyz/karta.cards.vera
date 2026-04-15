// Display formatting helpers shared across pages.

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    minor / 100,
  );
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Floor((deadline - now) / 1000), clamped at 0.  ISO string in, integer out. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}
