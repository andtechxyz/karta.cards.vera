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
