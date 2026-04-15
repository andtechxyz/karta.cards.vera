// Luhn check for PAN validation.  Done client-side for immediate feedback;
// the backend re-validates via the vault's own Luhn check on /vault/store.

export function luhnValid(pan: string): boolean {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
