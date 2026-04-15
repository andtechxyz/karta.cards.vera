// Template substitution for the Basis-Theory-parallel outbound proxy.
//
// A caller POSTs { retrievalToken, destination, method, headers, body } where
// headers and body may contain {{pan}}, {{cvc}}, {{expMonth}}, {{expYear}},
// {{cardholderName}}, {{last4}}, {{bin}}.  We consume the retrieval token
// atomically inside the vault module, decrypt, then substitute into the
// outbound request.  The plaintext NEVER reaches the caller.
//
// Substitution rules:
//   - Placeholders are exact matches: "{{pan}}" not "{{ pan }}".
//   - Unknown placeholders throw — "fail closed" so a typo doesn't leak a
//     literal "{{pan}}" to the upstream.
//   - A template value is JSON-safe (no escaping) because we substitute at
//     the string level before the HTTP client sends it.  Callers that need
//     escaping should base64-encode the placeholder they substitute and
//     decode upstream.

export interface TemplateValues {
  pan: string;
  cvc?: string;
  expMonth: string;
  expYear: string;
  cardholderName: string;
  last4: string;
  bin: string;
}

const KNOWN = new Set<keyof TemplateValues>([
  'pan',
  'cvc',
  'expMonth',
  'expYear',
  'cardholderName',
  'last4',
  'bin',
]);

const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export function substitute(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => {
    if (!KNOWN.has(key as keyof TemplateValues)) {
      throw new Error(`Unknown template placeholder: {{${key}}}`);
    }
    const v = values[key as keyof TemplateValues];
    if (v === undefined) {
      throw new Error(`Template placeholder {{${key}}} has no value for this vault entry`);
    }
    return v;
  });
}

export function substituteHeaders(
  headers: Record<string, string>,
  values: TemplateValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = substitute(v, values);
  }
  return out;
}
