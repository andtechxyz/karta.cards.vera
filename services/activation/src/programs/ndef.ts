import { badRequest } from '@vera/core';
import { getActivationConfig } from '../env.js';

// NDEF URL template renderer for activation service.
// Post-activation NDEF URL points to pay service (taps after activation → payment).

const SDM_MARKERS = ['{PICCData}', '{CMAC}'] as const;

export interface NdefUrlPair {
  preActivation: string;
  postActivation: string;
}

export interface RenderNdefInput {
  cardRef: string;
  preActivationTemplate?: string | null;
  postActivationTemplate?: string | null;
}

export function renderNdefUrls(input: RenderNdefInput): NdefUrlPair {
  const config = getActivationConfig();
  const tapOrigin = `https://tap.karta.cards`;
  const payOrigin = config.PAY_URL;

  const pre =
    input.preActivationTemplate ??
    `${tapOrigin}/activate/{cardRef}?e={PICCData}&m={CMAC}`;
  const post =
    input.postActivationTemplate ??
    `${payOrigin}/tap/{cardRef}?e={PICCData}&m={CMAC}`;

  return {
    preActivation: pre.replaceAll('{cardRef}', input.cardRef),
    postActivation: post.replaceAll('{cardRef}', input.cardRef),
  };
}

export function validateNdefUrlTemplate(template: string): void {
  if (!/^https?:\/\//i.test(template)) {
    throw badRequest('invalid_ndef_template', `NDEF URL template must be http(s): got "${template}"`);
  }
  if (!template.includes('{cardRef}')) {
    throw badRequest('invalid_ndef_template', `NDEF URL template must contain {cardRef}: "${template}"`);
  }
  const tokens = template.match(/\{[^}]+\}/g) ?? [];
  const allowed = new Set<string>(['{cardRef}', ...SDM_MARKERS]);
  for (const tok of tokens) {
    if (!allowed.has(tok)) {
      throw badRequest('invalid_ndef_template', `Unknown placeholder ${tok}`);
    }
  }
}
