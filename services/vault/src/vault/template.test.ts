import { describe, it, expect } from 'vitest';
import { substitute, substituteHeaders } from './template.js';

const VALUES = {
  pan: '4242424242424242',
  cvc: '123',
  expMonth: '12',
  expYear: '28',
  cardholderName: 'Test User',
  last4: '4242',
  bin: '424242',
};

describe('template.substitute', () => {
  it('replaces every known placeholder in a JSON body template', () => {
    const tpl = `{"number":"{{pan}}","cvc":"{{cvc}}","exp_month":"{{expMonth}}","exp_year":"{{expYear}}","name":"{{cardholderName}}"}`;
    const out = substitute(tpl, VALUES);
    expect(out).toBe(
      `{"number":"4242424242424242","cvc":"123","exp_month":"12","exp_year":"28","name":"Test User"}`,
    );
  });

  it('leaves non-placeholder text untouched', () => {
    expect(substitute('static text — no placeholders', VALUES)).toBe('static text — no placeholders');
  });

  it('substitutes the same placeholder multiple times', () => {
    expect(substitute('{{last4}}-{{last4}}', VALUES)).toBe('4242-4242');
  });

  it('throws on an unknown placeholder (fail closed)', () => {
    expect(() => substitute('{{unknown}}', VALUES)).toThrow(/Unknown template placeholder/);
  });

  it('throws when a known placeholder has no value (e.g. cvc absent)', () => {
    const noCvc = { ...VALUES, cvc: undefined as unknown as string };
    expect(() => substitute('{{cvc}}', noCvc)).toThrow(/no value/);
  });

  it('does not match {{ pan }} with whitespace — exact match only', () => {
    // Whitespace inside the braces should leave the text alone (regex demands [a-zA-Z0-9_]+).
    expect(substitute('{{ pan }}', VALUES)).toBe('{{ pan }}');
  });
});

describe('template.substituteHeaders', () => {
  it('substitutes inside header values', () => {
    const out = substituteHeaders(
      { 'X-Card': '{{last4}}', Authorization: 'Bearer {{bin}}' },
      VALUES,
    );
    expect(out['X-Card']).toBe('4242');
    expect(out.Authorization).toBe('Bearer 424242');
  });

  it('propagates unknown-placeholder errors from inside headers', () => {
    expect(() => substituteHeaders({ 'X-Bad': '{{nope}}' }, VALUES)).toThrow();
  });
});
